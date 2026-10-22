import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync, spawn } from "node:child_process";
import { ROOT_CONTEXT, trace, type Span } from "@opentelemetry/api";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import protobuf from "protobufjs/light.js";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Attachment,
  createHue,
  createHueTransport,
  type ExportIssue,
  type HueClient,
  type HueTransport,
} from "../src/index.js";
import {
  BlobUploader,
  digestOf,
  FALLBACK_MESSAGES,
  fallbackAttributes,
  LATE_FALLBACK_MESSAGES,
  MAX_HELD_BLOB_BYTES,
  newTally,
  offloadAttributes,
} from "../src/blobs.js";
import { fileSource } from "../src/attachment.js";
import { longFileBytes, readLargeMediaText } from "../src/large-media.js";
import { MAX_INLINE_FILE_TEXT } from "../src/inline-files.js";
import { rehydrateMedia } from "../src/evals.js";
import corpus from "./fixtures/media-parts/cases.json" with { type: "json" };
import schema from "./fixtures/otlp-schema.json" with { type: "json" };

type Value = {
  stringValue?: string;
  bytesValue?: string;
  boolValue?: boolean;
  intValue?: string;
  kvlistValue?: { values: Attribute[] };
  arrayValue?: { values: Value[] };
};
type Attribute = { key: string; value: Value };
type WireRecord = {
  traceId: string;
  name?: string;
  attributes?: Attribute[];
  body?: Value;
  events?: { name: string; attributes?: Attribute[] }[];
  links?: { attributes?: Attribute[] }[];
  resourceAttributes?: Attribute[];
};

type StagingTransport = HueTransport & {
  stageMedia(
    span: { spanContext(): { traceId: string; spanId: string } },
    file: {
      bytes: Uint8Array;
      digest: { sha256: string; size: number };
      contentType: string;
    },
  ): boolean;
};

const root = protobuf.Root.fromJSON(schema);
const apiKey = "synthetic-hue-blob-key";
const KiB = 1024;
const MiB = 1024 * KiB;

/** How the synthetic Hue answers the upload routes. */
interface Behavior {
  /** The reservation route's status; 200 answers `exists` or `upload` as the store holds it,
   * unless a `body` is given. */
  reserve?: (index: number) => {
    status: number;
    headers?: Record<string, string>;
    json?: boolean;
    body?: string;
  };
  /** The store's status for a PUT, or its status and headers; 200 stores the bytes. */
  put?: (
    index: number,
  ) => number | "hang" | "expired" | { status: number; headers: Record<string, string> };
  beforePut?: () => Promise<void>;
  complete?: (index: number) => number;
  /** The status and headers of the `index`th OTLP request's reply (1-based); a status other than
   * 200 refuses the request, whose records are not kept. */
  otlp?: (
    index: number,
    signal: "traces" | "logs",
  ) => { status: number; headers?: Record<string, string> } | undefined;
}

/**
 * A loopback Hue implementing the large-value contract: `POST /api/v1/otlp/blobs` answers
 * `exists` for a value it stores under the trace or a presigned PUT to its own store, the store
 * checks the PUT as S3 checks a presigned one (exact length, SHA-256 checksum, content type,
 * `If-None-Match`, no Hue credentials), and `/complete` checks the object. OTLP requests are
 * decoded and kept.
 */
function hue(behavior: Behavior = {}) {
  const records: { signal: "traces" | "logs"; record: WireRecord }[] = [];
  const reservations: Record<string, unknown>[] = [];
  const puts: { headers: Record<string, string>; bytes: number; status: number }[] = [];
  const completions: Record<string, unknown>[] = [];
  const decodedRequests: { signal: "traces" | "logs"; bytes: number }[] = [];
  /** Objects by `<trace>/<sha256>`: their bytes and content type. */
  const store = new Map<string, { bytes: Buffer; contentType: string }>();
  let reserveCount = 0;
  let putCount = 0;
  let otlpCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      if (url.pathname.startsWith("/store/")) {
        await behavior.beforePut?.();
        const answer = behavior.put?.(++putCount) ?? 200;
        const status = typeof answer === "object" ? answer.status : answer;
        if (status === "hang") {
          await new Promise(() => {});
          return new Response(null);
        }
        if (status === "expired") {
          await request.arrayBuffer();
          puts.push({ headers, bytes: 0, status: 403 });
          return new Response(
            "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
            { status: 403 },
          );
        }
        const bytes = Buffer.from(await request.arrayBuffer());
        const objectKey = url.pathname.slice("/store/".length);
        const put = { headers, bytes: bytes.byteLength, status };
        puts.push(put);
        if (status !== 200)
          return new Response("<Error><Code>InternalError</Code></Error>", {
            status,
            ...(typeof answer === "object" ? { headers: answer.headers } : {}),
          });
        // S3 refuses a presigned PUT sent chunked: its length is signed.
        if (headers["transfer-encoding"] !== undefined) {
          put.status = 501;
          return new Response("<Error><Code>NotImplemented</Code></Error>", { status: 501 });
        }
        const [, sha256] = objectKey.split("/");
        const checksum = createHash("sha256").update(bytes).digest("base64");
        if (
          headers.authorization !== undefined ||
          headers["if-none-match"] !== "*" ||
          headers["x-amz-checksum-sha256"] !== checksum ||
          createHash("sha256").update(bytes).digest("hex") !== sha256 ||
          Number(headers["content-length"]) !== bytes.byteLength
        ) {
          put.status = 400;
          return new Response("<Error><Code>BadDigest</Code></Error>", { status: 400 });
        }
        if (store.has(objectKey)) {
          put.status = 412;
          return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
        }
        store.set(objectKey, { bytes, contentType: headers["content-type"]! });
        return new Response(null, { status: 200 });
      }
      expect(request.headers.get("authorization")).toMatch(
        /^Bearer (?:synthetic-hue-blob-key|hue_setup_synthetic)$/,
      );
      if (url.pathname === "/api/v1/otlp/blobs") {
        const body = (await request.json()) as Record<string, unknown>;
        reservations.push(body);
        const answer = behavior.reserve?.(++reserveCount);
        if (answer?.body !== undefined)
          return new Response(answer.body, { status: answer.status, headers: answer.headers });
        if (answer && answer.status !== 200)
          return answer.json === false
            ? new Response("Not Found", { status: answer.status, headers: answer.headers })
            : Response.json(
                { error: "Synthetic refusal." },
                { status: answer.status, headers: answer.headers },
              );
        const objectKey = `${String(body.traceId)}/${String(body.sha256)}`;
        const ref = {
          key: body.key,
          sha256: body.sha256,
          size: body.byteSize,
          content_type: body.contentType,
        };
        // Hue answers a value it stores with the type it was first stored under.
        const stored = store.get(objectKey);
        if (stored)
          return Response.json({
            status: "exists",
            ref: { ...ref, content_type: stored.contentType },
          });
        return Response.json({
          status: "upload",
          url: `http://127.0.0.1:${server.port}/store/${objectKey}?X-Amz-Signature=synthetic`,
          method: "PUT",
          headers: {
            "Content-Length": String(body.byteSize),
            "Content-Type": body.contentType,
            "If-None-Match": "*",
            "x-amz-checksum-sha256": Buffer.from(String(body.sha256), "hex").toString("base64"),
          },
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          ref,
        });
      }
      if (url.pathname === "/api/v1/otlp/blobs/complete") {
        const body = (await request.json()) as Record<string, unknown>;
        completions.push(body);
        const status = behavior.complete?.(completions.length) ?? 200;
        if (status !== 200) return new Response(null, { status });
        if (!store.has(`${String(body.traceId)}/${String(body.sha256)}`))
          return Response.json({ error: "Not uploaded.", status: "missing" }, { status: 409 });
        return Response.json({ status: "complete" });
      }
      const signal = url.pathname.endsWith("/logs") ? "logs" : "traces";
      const namespace = `opentelemetry.proto.collector.${signal === "traces" ? "trace" : "logs"}.v1.Export${signal === "traces" ? "Trace" : "Logs"}Service`;
      let bytes = Buffer.from(await request.arrayBuffer());
      const refusal = behavior.otlp?.(++otlpCount, signal);
      if (refusal && refusal.status !== 200)
        return new Response("synthetic refusal", {
          status: refusal.status,
          headers: refusal.headers,
        });
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      decodedRequests.push({ signal, bytes: bytes.byteLength });
      const type = root.lookupType(`${namespace}Request`);
      const data = type.toObject(type.decode(bytes), { longs: String, bytes: String });
      const decoded: WireRecord[] =
        signal === "traces"
          ? data.resourceSpans.flatMap(
              (group: {
                resource?: { attributes?: Attribute[] };
                scopeSpans: { spans: WireRecord[] }[];
              }) =>
                group.scopeSpans.flatMap((scope) =>
                  scope.spans.map((span) => ({
                    ...span,
                    resourceAttributes: group.resource?.attributes,
                  })),
                ),
            )
          : data.resourceLogs.flatMap(
              (group: {
                resource?: { attributes?: Attribute[] };
                scopeLogs: { logRecords: WireRecord[] }[];
              }) =>
                group.scopeLogs.flatMap((scope) =>
                  scope.logRecords.map((record) => ({
                    ...record,
                    resourceAttributes: group.resource?.attributes,
                  })),
                ),
            );
      for (const record of decoded) records.push({ signal, record });
      const responseType = root.lookupType(`${namespace}Response`);
      return new Response(
        new Uint8Array(responseType.encode(responseType.fromObject({})).finish()),
        {
          headers: {
            "content-type": "application/x-protobuf",
            ...(signal === "traces" ? { "hue-pending-spans": "1" } : {}),
          },
        },
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    server,
    store,
    reservations,
    puts,
    completions,
    decodedRequests,
    span: (name: string) =>
      records.find(({ signal, record }) => signal === "traces" && record.name === name)?.record,
    logs: () => records.filter(({ signal }) => signal === "logs").map(({ record }) => record),
  };
}

function attr(record: WireRecord, key: string): Value | undefined {
  return record.attributes?.find((item) => item.key === key)?.value;
}

function strings(value: Value | undefined): string[] | undefined {
  return value?.arrayValue?.values.map((item) => item.stringValue!);
}

/** The `hue.blobs` entries of a record, parsed. */
function blobs(record: WireRecord) {
  return (strings(attr(record, "hue.blobs")) ?? []).map(
    (entry) =>
      JSON.parse(entry) as {
        key: string;
        sha256: string;
        size: number;
        content_type: string;
        name?: string;
      },
  );
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** A GenAI message with an inline image part of `bytes` raw bytes. */
function messageWithImage(bytes: Buffer) {
  return JSON.stringify([
    {
      role: "user",
      parts: [
        { type: "text", content: "Describe this image." },
        {
          type: "blob",
          modality: "image",
          mime_type: "image/png",
          content: bytes.toString("base64"),
        },
      ],
    },
  ]);
}

function client(endpoint: { url: string }, options: Record<string, unknown> = {}) {
  return createHue({
    apiKey,
    serviceName: "blob-tests",
    captureContent: true,
    baseUrl: endpoint.url,
    ...options,
  } as Parameters<typeof createHue>[0]);
}

describe("values over the inline limit", () => {
  test("are uploaded to Hue and replaced by their first 16 KiB, listed under hue.blobs", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const text = `${"é".repeat(900 * KiB)}tail`;
    const image = randomBytes(200 * KiB);
    const rows = Array.from({ length: 30_000 }, (_, id) => ({ id, note: "n".repeat(40) }));
    try {
      let traceId = "";
      await hueClient.withSpan(
        "offloaded",
        (context) => {
          traceId = context.span.spanContext().traceId;
          context.span.setAttribute("custom.document", text);
          context.span.setAttribute("gen_ai.input.messages", messageWithImage(image));
          context.setOutput(rows);
        },
        { input: "short input" },
      );
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(3);
      expect(report.uploadFallbacks).toBe(0);
      expect(hueClient.transport.getIssues().filter((issue) => issue.kind === "warning")).toEqual(
        [],
      );
      const record = endpoint.span("offloaded")!;
      const entries = blobs(record);
      const rowsText = JSON.stringify(rows);
      expect(entries).toEqual([
        {
          key: "custom.document",
          sha256: sha256(text),
          size: Buffer.byteLength(text),
          content_type: "text/plain; charset=utf-8",
        },
        {
          key: "gen_ai.input.messages#/0/parts/1",
          sha256: sha256(image),
          size: image.byteLength,
          content_type: "image/png",
        },
        {
          key: "output.value",
          sha256: sha256(rowsText),
          size: Buffer.byteLength(rowsText),
          content_type: "application/json",
        },
      ]);
      // The store holds exactly the bytes the entries name, under the span's trace.
      for (const entry of entries) {
        const object = endpoint.store.get(`${traceId}/${entry.sha256}`)!;
        expect(object.bytes.byteLength).toBe(entry.size);
        expect(object.contentType).toBe(entry.content_type);
      }
      expect(endpoint.store.get(`${traceId}/${sha256(text)}`)!.bytes.toString("utf8")).toBe(text);
      expect(endpoint.store.get(`${traceId}/${sha256(image)}`)!.bytes.equals(image)).toBe(true);
      // Each value keeps its first 16 KiB inline: text cut back to a character.
      const document = attr(record, "custom.document")!.stringValue!;
      expect(Buffer.byteLength(document)).toBe(16 * KiB);
      expect(text.startsWith(document)).toBe(true);
      const output = attr(record, "output.value")!.stringValue!;
      expect(rowsText.startsWith(output)).toBe(true);
      expect(Buffer.byteLength(output)).toBe(16 * KiB);
      // The binary part keeps provider metadata and carries its decoded identity.
      const [message] = JSON.parse(attr(record, "gen_ai.input.messages")!.stringValue!) as {
        parts: Record<string, unknown>[];
      }[];
      expect(message!.parts[0]).toEqual({ type: "text", content: "Describe this image." });
      expect(message!.parts[1]).toEqual({
        type: "blob",
        modality: "image",
        mime_type: "image/png",
        sha256: sha256(image),
        size: image.byteLength,
      });
      // The whole values are listed as cut inline; a part is listed in hue.blobs alone.
      expect(strings(attr(record, "hue.truncated"))).toEqual(["custom.document", "output.value"]);
      expect(attr(record, "input.value")!.stringValue).toBe('"short input"');
      // Each upload was reserved with the record's trace and key, and completed.
      expect(endpoint.reservations.map((body) => body.key)).toEqual(
        expect.arrayContaining(entries.map((entry) => entry.key)),
      );
      expect(endpoint.reservations.every((body) => body.traceId === traceId)).toBe(true);
      expect(endpoint.completions).toHaveLength(3);
      expect(endpoint.puts.every((put) => put.headers.authorization === undefined)).toBe(true);
      // Each PUT carried its signed length, never a chunked body.
      expect(endpoint.puts.map((put) => put.status)).toEqual([200, 200, 200]);
      expect(endpoint.puts.every((put) => put.headers["transfer-encoding"] === undefined)).toBe(
        true,
      );
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a value Hue already stores under the trace is not uploaded again", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const text = "r".repeat(3 * MiB);
    try {
      await hueClient.withSpan("first", async (context) => {
        context.span.setAttribute("tool.output", text);
        await hueClient.withSpan("second", (child) => {
          child.span.setAttribute("tool.output", text);
        });
        // The child is exported, its value uploaded, before the parent ends.
        await hueClient.flush();
      });
      await hueClient.flush();
      // The parent reuses the successful reservation in the same trace.
      expect(endpoint.puts).toHaveLength(1);
      expect(endpoint.reservations).toHaveLength(1);
      expect(endpoint.completions).toHaveLength(1);
      for (const name of ["first", "second"]) {
        const record = endpoint.span(name)!;
        expect(blobs(record)).toEqual([
          {
            key: "tool.output",
            sha256: sha256(text),
            size: text.length,
            content_type: "text/plain; charset=utf-8",
          },
        ]);
        expect(attr(record, "tool.output")!.stringValue).toBe("r".repeat(16 * KiB));
      }
      expect(hueClient.transport.getReport().uploadedValues).toBe(2);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("two spans uploading one value at once share the in-flight reservation", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const text = "w".repeat(2 * MiB);
    try {
      await hueClient.withSpan("parent", async (context) => {
        context.span.setAttribute("tool.output", text);
        await hueClient.withSpan("child", (child) => {
          child.span.setAttribute("tool.output", text);
        });
      });
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(2);
      expect(report.uploadFallbacks).toBe(0);
      expect(endpoint.puts.map((put) => put.status)).toEqual([200]);
      expect(endpoint.reservations).toHaveLength(1);
      expect(endpoint.store.size).toBe(1);
      for (const name of ["parent", "child"])
        expect(blobs(endpoint.span(name)!).map((entry) => entry.sha256)).toEqual([sha256(text)]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("an expired upload URL is reserved again once", async () => {
    const endpoint = hue({ put: (index) => (index === 1 ? "expired" : 200) });
    const hueClient = client(endpoint);
    try {
      await hueClient.withSpan("expired", (context) => {
        context.span.setAttribute("custom.document", "e".repeat(2 * MiB));
      });
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(1);
      expect(endpoint.reservations).toHaveLength(2);
      expect(endpoint.puts.map((put) => put.status)).toEqual([403, 200]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("Hue's own 404 (an archived project) is a failure, not a receiver without uploads", async () => {
    const endpoint = hue({ reserve: () => ({ status: 404 }) });
    const hueClient = client(endpoint);
    try {
      await hueClient.withSpan("archived", (context) => {
        context.span.setAttribute("custom.document", "a".repeat(2 * MiB));
      });
      await hueClient.flush();
      // The span went out first: it lists the value, which Hue does not store.
      const archived = endpoint.span("archived")!;
      expect(attr(archived, "custom.document")!.stringValue).toBe("a".repeat(16 * KiB));
      expect(blobs(archived).map(({ key }) => key)).toEqual(["custom.document"]);
      expect(
        hueClient.transport
          .getIssues()
          .filter((issue) => issue.message === LATE_FALLBACK_MESSAGES.failed),
      ).toHaveLength(1);
      // Not taken for a receiver without the route, whose values are cut when queued: the next
      // value reserves again.
      expect(mediaState(hueClient).uploader.unsupportedUntil).toBe(0);
      await hueClient.withSpan("again", (context) => {
        context.span.setAttribute("custom.document", "a".repeat(2 * MiB));
      });
      await hueClient.flush();
      expect(endpoint.reservations).toHaveLength(2);
      expect(blobs(endpoint.span("again")!).map(({ key }) => key)).toEqual(["custom.document"]);
      expect(
        hueClient.transport
          .getIssues()
          .filter((issue) => issue.message === LATE_FALLBACK_MESSAGES.failed),
      ).toHaveLength(2);
      expect(hueClient.transport.getReport().uploadFallbacks).toBe(2);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  for (const [name, answer] of [
    ["405", { status: 405, json: false }],
    ["501", { status: 501, json: false }],
    ["200 text", { status: 200, body: "OK" }],
    ["200 other JSON", { status: 200, body: '{"accepted":true}' }],
  ] as const)
    test(`a receiver that answers the reservation ${name} lacks the upload route`, async () => {
      const endpoint = hue({ reserve: () => answer });
      const hueClient = client(endpoint);
      try {
        for (const span of ["first", "second"]) {
          await hueClient.withSpan(span, (context) => {
            context.span.setAttribute("custom.document", "r".repeat(2 * MiB));
          });
          await hueClient.flush();
        }
        // The first span went out before the receiver answered: it keeps its prefix and lists the
        // value, which it does not store. The second is cut when queued, as before uploads.
        const first = endpoint.span("first")!;
        expect(attr(first, "custom.document")!.stringValue).toBe("r".repeat(16 * KiB));
        expect(blobs(first).map(({ key }) => key)).toEqual(["custom.document"]);
        const second = endpoint.span("second")!;
        expect(attr(second, "custom.document")!.stringValue).toBe("r".repeat(MiB));
        expect(attr(second, "hue.blobs")).toBeUndefined();
        expect(endpoint.reservations).toHaveLength(1);
        expect(endpoint.puts).toHaveLength(0);
        const warnings = hueClient.transport
          .getIssues()
          .filter((issue) => issue.message.startsWith("This Hue server does not accept uploaded"));
        expect(warnings.map((issue) => [issue.message, issue.count])).toEqual([
          [LATE_FALLBACK_MESSAGES.unsupported, 1],
          [FALLBACK_MESSAGES.unsupported, 1],
        ]);
      } finally {
        await hueClient.shutdown();
        endpoint.server.stop(true);
      }
    });

  test("a value whose upload fails after export keeps its prefix and entry; the next value still tries", async () => {
    const endpoint = hue({ put: () => 503 });
    const issues: ExportIssue[] = [];
    const hueClient = client(endpoint, {
      onExportIssue: (issue: ExportIssue) => {
        issues.push(issue);
      },
    });
    fastRetries(hueClient);
    const text = "f".repeat(2 * MiB);
    const image = randomBytes(100 * KiB);
    try {
      let traceId = "";
      await hueClient.withSpan("fallback", (context) => {
        traceId = context.span.spanContext().traceId;
        context.span.setAttribute("custom.document", text);
        context.span.setAttribute("gen_ai.input.messages", messageWithImage(image));
      });
      // The export succeeds: every record was delivered, listing its values, before they failed.
      const report = await hueClient.flush();
      expect(report.acceptedSpans).toBe(1);
      expect(report.uploadedValues).toBe(0);
      expect(report.uploadFallbacks).toBe(2);
      const record = endpoint.span("fallback")!;
      expect(attr(record, "custom.document")!.stringValue).toBe("f".repeat(16 * KiB));
      expect(strings(attr(record, "hue.truncated"))).toEqual(["custom.document"]);
      expect(blobs(record).map(({ key, sha256: digest }) => [key, digest])).toEqual([
        ["custom.document", sha256(text)],
        ["gen_ai.input.messages#/0/parts/1", sha256(image)],
      ]);
      expect(endpoint.store.size).toBe(0);
      // The image is its digest, as an uploaded one is.
      const [message] = JSON.parse(attr(record, "gen_ai.input.messages")!.stringValue!) as {
        parts: Record<string, unknown>[];
      }[];
      expect(message!.parts[1]).toEqual({
        type: "blob",
        modality: "image",
        mime_type: "image/png",
        sha256: sha256(image),
        size: image.byteLength,
      });
      const warning = hueClient.transport
        .getIssues()
        .find((issue) => issue.message.includes("could not be uploaded"))!;
      expect(warning).toMatchObject({
        kind: "warning",
        count: 2,
        traceIds: [traceId],
        message: LATE_FALLBACK_MESSAGES.failed,
      });
      expect(issues.some((issue) => issue.message === warning.message)).toBe(true);
      // Each value's PUT was tried three times, never more.
      expect(endpoint.puts.length).toBe(6);
      // Nothing pauses: a later value is reserved and tried again.
      await hueClient.withSpan("again", (context) => {
        context.span.setAttribute("custom.document", text);
      });
      await hueClient.flush();
      expect(endpoint.reservations).toHaveLength(3);
      expect(endpoint.puts.length).toBe(9);
      expect(attr(endpoint.span("again")!, "custom.document")!.stringValue).toBe(
        "f".repeat(16 * KiB),
      );
      expect(blobs(endpoint.span("again")!).map(({ key }) => key)).toEqual(["custom.document"]);
      expect(hueClient.transport.getReport().uploadFallbacks).toBe(3);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a receiver without the upload route is remembered, and values are cut when queued again", async () => {
    const endpoint = hue({ reserve: () => ({ status: 404, json: false }) });
    const hueClient = client(endpoint);
    const text = "n".repeat(2 * MiB);
    try {
      for (const name of ["first", "second"]) {
        await hueClient.withSpan(name, (context) => {
          context.span.setAttribute("custom.document", text);
        });
        await hueClient.flush();
      }
      // Exported before the receiver answered, the first value keeps its prefix and its entry.
      expect(attr(endpoint.span("first")!, "custom.document")!.stringValue).toBe(
        "n".repeat(16 * KiB),
      );
      expect(blobs(endpoint.span("first")!)).toHaveLength(1);
      expect(attr(endpoint.span("second")!, "custom.document")!.stringValue).toBe("n".repeat(MiB));
      expect(attr(endpoint.span("second")!, "hue.blobs")).toBeUndefined();
      expect(endpoint.reservations).toHaveLength(1);
      const warnings = hueClient.transport
        .getIssues()
        .filter((issue) => issue.message.startsWith("This Hue server does not accept uploaded"));
      expect(warnings.map((issue) => [issue.message, issue.count])).toEqual([
        [LATE_FALLBACK_MESSAGES.unsupported, 1],
        [FALLBACK_MESSAGES.unsupported, 1],
      ]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a message's large inline file is held for upload apart from the queue's byte budget", async () => {
    const endpoint = hue();
    // The message's text is larger than the whole queue; its copy with the file as its digest
    // is not, so the queue takes the span as it did before uploads existed.
    const hueClient = client(endpoint, { maxQueueBytes: 256 * KiB });
    const image = randomBytes(200 * KiB);
    try {
      await hueClient.withSpan("small queue", (context) => {
        context.span.setAttribute("gen_ai.input.messages", messageWithImage(image));
      });
      const report = await hueClient.flush();
      expect(report.droppedSpans).toBe(0);
      expect(report.uploadedValues).toBe(1);
      expect(blobs(endpoint.span("small queue")!)).toMatchObject([
        { key: "gen_ai.input.messages#/0/parts/1", sha256: sha256(image) },
      ]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("inline files queued while the receiver lacks the upload route are reported, one per file", async () => {
    const endpoint = hue({ reserve: () => ({ status: 404, json: false }) });
    const hueClient = client(endpoint);
    const images = [randomBytes(100 * KiB), randomBytes(120 * KiB)];
    try {
      await hueClient.withSpan("learn", (context) => {
        context.span.setAttribute("custom.document", "n".repeat(2 * MiB));
      });
      await hueClient.flush();
      await hueClient.withSpan("files", (context) => {
        context.span.setAttribute(
          "gen_ai.input.messages",
          JSON.stringify(
            images.map((image) => ({
              role: "user",
              parts: [{ type: "blob", mime_type: "image/png", content: image.toString("base64") }],
            })),
          ),
        );
      });
      const report = await hueClient.flush();
      expect(endpoint.reservations).toHaveLength(1);
      expect(report.uploadFallbacks).toBe(3);
      const messages = JSON.parse(
        attr(endpoint.span("files")!, "gen_ai.input.messages")!.stringValue!,
      ) as { parts: Record<string, unknown>[] }[];
      expect(messages.map((message) => message.parts[0]!.sha256)).toEqual(images.map(sha256));
      const warnings = hueClient.transport
        .getIssues()
        .filter((issue) => issue.message.startsWith("This Hue server does not accept uploaded"));
      expect(warnings.map((issue) => issue.count)).toEqual([1, 2]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a message cut after the queue digested its files reports the files and the cut", async () => {
    const endpoint = hue({ reserve: () => ({ status: 404, json: false }) });
    const hueClient = client(endpoint);
    // With its file as a digest, one message is still over the value limit but within what the
    // queue keeps for the redactor (cut on export); the other is cut when it is queued.
    const message = (text: string) =>
      JSON.stringify([
        {
          role: "user",
          parts: [
            { type: "text", content: text },
            {
              type: "blob",
              mime_type: "image/png",
              content: randomBytes(100 * KiB).toString("base64"),
            },
          ],
        },
      ]);
    try {
      await hueClient.withSpan("learn", (context) => {
        context.span.setAttribute("custom.document", "n".repeat(2 * MiB));
      });
      await hueClient.flush();
      await hueClient.withSpan("long", (context) => {
        context.span.setAttribute("gen_ai.input.messages", message("t".repeat(MiB + 20 * KiB)));
        context.span.setAttribute("gen_ai.output.messages", message("u".repeat(MiB + 200 * KiB)));
      });
      const report = await hueClient.flush();
      expect(report.uploadFallbacks).toBe(5);
      expect(strings(attr(endpoint.span("long")!, "hue.truncated"))?.sort()).toEqual([
        "gen_ai.input.messages",
        "gen_ai.output.messages",
      ]);
      const warnings = hueClient.transport
        .getIssues()
        .filter((issue) => issue.message.startsWith("This Hue server does not accept uploaded"));
      expect(warnings.map((issue) => issue.count)).toEqual([1, 4]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("messages queued as the same cut text report their own files", async () => {
    const endpoint = hue({ reserve: () => ({ status: 404, json: false }) });
    const hueClient = client(endpoint);
    // Both messages are cut when queued to the same text; their files, past the cut, differ.
    const message = (images: number) =>
      JSON.stringify([
        {
          role: "user",
          parts: [
            { type: "text", content: "u".repeat(MiB + 200 * KiB) },
            ...Array.from({ length: images }, () => ({
              type: "blob",
              mime_type: "image/png",
              content: randomBytes(100 * KiB).toString("base64"),
            })),
          ],
        },
      ]);
    try {
      await hueClient.withSpan("learn", (context) => {
        context.span.setAttribute("custom.document", "n".repeat(2 * MiB));
      });
      await hueClient.flush();
      await hueClient.withSpan("shared prefix", (context) => {
        context.span.setAttribute("gen_ai.input.messages", message(1));
        context.span.setAttribute("gen_ai.output.messages", message(2));
      });
      await hueClient.flush();
      const record = endpoint.span("shared prefix")!;
      expect(attr(record, "gen_ai.input.messages")!.stringValue).toBe(
        attr(record, "gen_ai.output.messages")!.stringValue,
      );
      // One file and one cut, then two files and one cut.
      const warnings = hueClient.transport
        .getIssues()
        .filter((issue) => issue.message.startsWith("This Hue server does not accept uploaded"));
      expect(warnings.map((issue) => issue.count)).toEqual([1, 5]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("the fallback for an upload step that failed reports each inline file it digests", () => {
    const tally = newTally();
    const attributes = fallbackAttributes(
      { "gen_ai.input.messages": messageWithImage(randomBytes(100 * KiB)) },
      {
        candidates: [
          { key: "gen_ai.input.messages", value: messageWithImage(randomBytes(100 * KiB)) },
        ],
        cut: [],
      },
      MiB,
      tally,
      "0af7651916cd43dd8448eb211c80319c",
    );
    expect(String(attributes["gen_ai.input.messages"])).toContain('"sha256"');
    expect(tally.fallbacks.get("failed")?.count).toBe(1);
  });

  test("a rate-limited reservation is retried after its Retry-After", async () => {
    let sentFirst = false;
    const endpoint = hue({
      reserve: (index) => {
        if (index === 2) sentFirst = endpoint.span("limited") !== undefined;
        return (index === 1 ? { status: 429, headers: { "Retry-After": "1" } } : undefined)!;
      },
    });
    const hueClient = client(endpoint);
    try {
      await hueClient.withSpan("limited", (context) => {
        context.span.setAttribute("custom.document", "l".repeat(2 * MiB));
      });
      const started = Date.now();
      await hueClient.flush();
      // The span went out while its value waited; the flush waits for the upload.
      expect(sentFirst).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(endpoint.reservations).toHaveLength(2);
      expect(blobs(endpoint.span("limited")!)).toHaveLength(1);
      expect(hueClient.transport.getReport().uploadedValues).toBe(1);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("the redactor's answer is what is uploaded, and metadata-only export uploads nothing", async () => {
    const endpoint = hue();
    const secret = "sk-synthetic-redacted-0123456789";
    const redacting = client(endpoint, {
      redact: (value: string) => value.replaceAll(secret, "[key]"),
    });
    const metadata = client(endpoint, { captureContent: false, serviceName: "metadata-only" });
    const text = `${"s".repeat(2 * MiB)}${secret}`;
    try {
      await redacting.withSpan("redacted", (context) => {
        context.span.setAttribute("custom.document", text);
      });
      await redacting.flush();
      const [object] = [...endpoint.store.values()];
      expect(object!.bytes.toString("utf8")).toBe(`${"s".repeat(2 * MiB)}[key]`);
      expect(object!.bytes.includes(secret)).toBe(false);
      expect(blobs(endpoint.span("redacted")!)[0]!.sha256).toBe(
        sha256(`${"s".repeat(2 * MiB)}[key]`),
      );
      // Without content capture, content is removed and nothing at all is uploaded: a custom
      // value over the limit is cut, as before.
      const reserved = endpoint.reservations.length;
      await metadata.withSpan("metadata", (context) => {
        context.span.setAttribute("input.value", text);
        context.span.setAttribute("custom.document", text);
      });
      await metadata.flush();
      expect(endpoint.reservations).toHaveLength(reserved);
      const record = endpoint.span("metadata")!;
      expect(attr(record, "input.value")).toBeUndefined();
      expect(attr(record, "custom.document")!.stringValue).toBe("s".repeat(MiB));
      expect(attr(record, "hue.blobs")).toBeUndefined();
      expect(metadata.transport.getReport().uploadFallbacks).toBe(0);
    } finally {
      await redacting.shutdown();
      await metadata.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a setup credential never uploads, and a log body is cut inline as before", async () => {
    const endpoint = hue();
    const setup = createHue({
      apiKey: "hue_setup_synthetic",
      serviceName: "setup",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const hueClient = client(endpoint);
    try {
      await setup.withSpan("setup", (context) => {
        context.span.setAttribute("custom.document", "x".repeat(2 * MiB));
      });
      await setup.flush().catch(() => undefined);
      // The client's own logger, as recordMessages and log instrumentations emit through it.
      (hueClient as unknown as { logger: { emit(record: { body: string }): void } }).logger.emit({
        body: "y".repeat(2 * MiB),
      });
      await hueClient.flush();
      expect(endpoint.reservations).toEqual([]);
      const [log] = endpoint.logs();
      expect(log!.body!.stringValue).toBe("y".repeat(MiB));
    } finally {
      await setup.shutdown().catch(() => undefined);
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a store that never answers delays only its upload", async () => {
    let sentFirst = false;
    let attempts = 0;
    const endpoint = hue({
      put: (index) => {
        attempts = index;
        // The first PUT has timed out by the time a second arrives.
        if (index === 2) sentFirst = endpoint.span("hung") !== undefined;
        return "hang";
      },
    });
    const hueClient = client(endpoint, { timeoutMillis: 200 });
    fastRetries(hueClient);
    try {
      await hueClient.withSpan("hung", (context) => {
        context.span.setAttribute("custom.document", "h".repeat(2 * MiB));
      });
      const started = Date.now();
      const report = await hueClient.flush();
      // Three PUTs that each time out when idle, with short waits between them.
      expect(Date.now() - started).toBeLessThan(2000);
      expect(sentFirst).toBe(true);
      expect(attempts).toBe(3);
      expect(report.uploadFallbacks).toBe(1);
      const record = endpoint.span("hung")!;
      expect(attr(record, "custom.document")!.stringValue).toBe("h".repeat(16 * KiB));
      expect(blobs(record).map(({ key }) => key)).toEqual(["custom.document"]);
    } finally {
      const outcome = await hueClient.shutdownSafe({ timeoutMillis: 2000 });
      expect(outcome.timedOut).toBe(false);
      endpoint.server.stop(true);
    }
  });
});

/** A corpus case's attribute text: its JSON `messages`, or its raw `value`. */
type CorpusCase = {
  id: string;
  attribute: string;
  messages?: unknown;
  value?: string;
  success: { messages?: unknown; value?: string; entries: string[] };
  failure: { messages?: unknown; value?: string; entries: string[] };
};
const fixtures = corpus.fixtures as CorpusCase[];

/** How a corpus case is run: uploaded, refused when its record is placed (the corpus's `failure`
 * form), or failed after its record was exported (the `success` form, its entries not stored). */
const MODES = ["success", "refused", "late failure"] as const;
type Mode = (typeof MODES)[number];
/** The corpus form a mode exports. */
const form = (mode: Mode) => (mode === "refused" ? "failure" : "success");
/** A receiver for `mode`: its reservations refused (403) for a late failure. */
const modeEndpoint = (mode: Mode) =>
  hue(mode === "late failure" ? { reserve: () => ({ status: 403 }) } : {});

/** For a late failure, every listed value was counted as failed, and none as uploaded. */
function expectLateFailures(hueClient: HueClient, entries: number) {
  const report = hueClient.transport.getReport();
  expect(report.uploadedValues).toBe(0);
  expect(report.uploadFallbacks).toBe(entries);
  const late = hueClient.transport
    .getIssues()
    .filter((issue) => issue.message === LATE_FALLBACK_MESSAGES.failed);
  expect(late.reduce((total, issue) => total + issue.count, 0)).toBe(entries);
}

for (const item of fixtures) {
  for (const mode of MODES) {
    test(`media wire ${mode}: ${item.id}`, async () => {
      const endpoint = modeEndpoint(mode);
      const hueClient = client(endpoint);
      const expected = item[form(mode)];
      try {
        await hueClient.withSpan(item.id, ({ span }) => {
          span.setAttribute(item.attribute, item.value ?? JSON.stringify(item.messages));
        });
        if (mode === "refused") refuseAtPlacement(hueClient);
        const report = await hueClient.flush();
        expect(report.acceptedSpans).toBe(1);
        const record = endpoint.span(item.id)!;
        const exported = attr(record, item.attribute)!.stringValue!;
        if (item.value === undefined) expect(JSON.parse(exported)).toEqual(expected.messages);
        else expect(exported).toBe(expected.value!);
        expect(strings(attr(record, "hue.blobs")) ?? []).toEqual(expected.entries);
        if (mode === "late failure") expectLateFailures(hueClient, expected.entries.length);
        if (mode === "refused") expect(endpoint.reservations).toEqual([]);
        expect(
          endpoint.reservations.every(
            (entry) => entry.traceId === Buffer.from(record.traceId!, "base64").toString("hex"),
          ),
        ).toBe(true);
      } finally {
        await hueClient.shutdown();
        endpoint.server.stop(true);
      }
    });
  }
}

test("a resolved text file over 64 KiB records again as the same file, not its base64", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const notes = Buffer.from("Quarterly notes, line 1\n".repeat(3000), "utf8");
  const digest = sha256(notes);
  const recorded = [
    {
      role: "user",
      parts: [
        { type: "blob", mime_type: "text/plain", name: "notes.txt", sha256: digest, size: 72_000 },
      ],
    },
  ];
  try {
    // The bytes are written back as Hue and the GenAI conventions read a `blob` part: base64.
    const { value, failures } = await rehydrateMedia(recorded, [{ sha256: digest, bytes: notes }]);
    expect(failures).toEqual([]);
    expect(value[0]!.parts[0]).toMatchObject({ content: notes.toString("base64") });
    await hueClient.withSpan("resolved again", ({ span }) => {
      span.setAttribute("gen_ai.input.messages", JSON.stringify(value));
    });
    const report = await hueClient.flush();
    expect([report.uploadedValues, report.uploadFallbacks]).toEqual([1, 0]);
    const record = endpoint.span("resolved again")!;
    expect(JSON.parse(attr(record, "gen_ai.input.messages")!.stringValue!)).toEqual(recorded);
    expect(blobs(record)).toEqual([
      {
        key: "gen_ai.input.messages#/0/parts/0",
        sha256: digest,
        size: 72_000,
        content_type: "text/plain",
        name: "notes.txt",
      },
    ]);
    expect([...endpoint.store.values()].map((object) => object.bytes)).toEqual([notes]);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("recordFile uploads are opt-in, copied, and share inline reservations on the same trace", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const bytes = Buffer.from([0, 1, 2, 3]);
  const digest = sha256(bytes);
  const name = "🎧".repeat(128);
  try {
    await hueClient.withSpan("default file", () => {
      hueClient.recordFile({ role: "attachment", mediaType: "image/png", data: bytes, name });
    });
    await hueClient.flush();
    expect(endpoint.reservations).toHaveLength(0);
    expect(endpoint.span("default file")!.events?.map((event) => event.name)).toContain("hue.file");
    await hueClient.withSpan("explicit file", async ({ span }) => {
      hueClient.recordFile({
        role: "attachment",
        mediaType: "image/png",
        data: bytes,
        name,
        upload: true,
      });
      span.setAttribute("gen_ai.input.messages", messageWithImage(bytes));
      await hueClient.withSpan("child file", () => {
        hueClient.recordFile({
          role: "output",
          mediaType: "image/png",
          data: bytes,
          name: "child.png",
          upload: true,
        });
      });
      bytes.fill(255);
    });
    const report = await hueClient.flush();
    expect(report.uploadFallbacks).toBe(0);
    expect(endpoint.reservations).toHaveLength(1);
    expect(endpoint.puts).toHaveLength(1);
    expect([...endpoint.store.values()][0]!.bytes).toEqual(Buffer.from([0, 1, 2, 3]));
    const record = endpoint.span("explicit file")!;
    expect(
      attr(
        record.events!.find((event) => event.name === "hue.file")! as WireRecord,
        "hue.file.name",
      )?.stringValue,
    ).toBe(name);
    expect(blobs(record)).toEqual([
      {
        key: "gen_ai.input.messages#/0/parts/1",
        sha256: digest,
        size: 4,
        content_type: "image/png",
      },
      { key: `event:hue.file:${digest}`, sha256: digest, size: 4, content_type: "image/png", name },
    ]);
    expect(blobs(endpoint.span("child file")!)).toEqual([
      {
        key: `event:hue.file:${digest}`,
        sha256: digest,
        size: 4,
        content_type: "image/png",
        name: "child.png",
      },
    ]);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("failed media reservations fail each occurrence without pausing or caching the failure", async () => {
  const endpoint = hue({ reserve: () => ({ status: 403 }) });
  const hueClient = client(endpoint);
  const bytes = Buffer.from([1, 2, 3]);
  try {
    await hueClient.withSpan("failed parent", async ({ span }) => {
      span.setAttribute("gen_ai.input.messages", messageWithImage(bytes));
      hueClient.recordFile({ role: "input", mediaType: "image/png", data: bytes, upload: true });
      await hueClient.withSpan("failed child", ({ span }) => {
        span.setAttribute("gen_ai.input.messages", messageWithImage(bytes));
      });
      await hueClient.flush();
    });
    const report = await hueClient.flush();
    expect(report.acceptedSpans).toBe(2);
    expect(report.uploadFallbacks).toBe(3);
    // The child's failure is not remembered: the parent's image reserves again, and its recorded
    // file shares that reservation.
    expect(endpoint.reservations).toHaveLength(2);
    expect(endpoint.puts).toHaveLength(0);
    expect(blobs(endpoint.span("failed parent")!).map(({ key }) => key)).toEqual([
      "gen_ai.input.messages#/0/parts/1",
      `event:hue.file:${sha256(bytes)}`,
    ]);
    expect(mediaState(hueClient).uploader.outcomes.size).toBe(0);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("media in logs, events, links, resources, and fetched URLs never authorizes uploads", async () => {
  const endpoint = hue();
  const bytes = Buffer.from([1, 2, 3]);
  const messages = messageWithImage(bytes);
  const hueClient = client(endpoint, { resourceAttributes: { "gen_ai.input.messages": messages } });
  try {
    await hueClient.withSpan("privacy surfaces", ({ span }) => {
      span.addEvent("custom", { "gen_ai.input.messages": messages });
      span.addLink({
        context: span.spanContext(),
        attributes: { "gen_ai.input.messages": messages },
      });
      span.setAttribute("custom.messages", messages);
      span.setAttribute(
        "gen_ai.input.messages",
        JSON.stringify([
          {
            content: [{ type: "image_url", image_url: { url: `${endpoint.url}/must-not-fetch` } }],
          },
        ]),
      );
    });
    (
      hueClient as unknown as {
        logger: { emit(record: { body: string; attributes: Record<string, string> }): void };
      }
    ).logger.emit({ body: messages, attributes: { "gen_ai.input.messages": messages } });
    await hueClient.flush();
    expect(endpoint.reservations).toHaveLength(0);
    expect(endpoint.puts).toHaveLength(0);
    expect(endpoint.logs()).toHaveLength(1);
    const span = endpoint.span("privacy surfaces")!;
    expect(attr(span.events![0]! as WireRecord, "gen_ai.input.messages")?.stringValue).toBe(
      messages,
    );
    expect(attr(span.links![0]! as WireRecord, "gen_ai.input.messages")?.stringValue).toBe(
      messages,
    );
    expect(
      attr({ traceId: "", attributes: span.resourceAttributes }, "gen_ai.input.messages")
        ?.stringValue,
    ).toBe(messages);
    expect(attr(endpoint.logs()[0]!, "gen_ai.input.messages")?.stringValue).toBe(messages);
    expect(endpoint.logs()[0]!.body?.stringValue).toBe(messages);
    expect(mediaState(hueClient).mediaMemo.entries.size).toBe(0);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("metadata-only, setup credentials, and redacted file events never upload explicit bytes", async () => {
  const endpoint = hue();
  const clients = [
    client(endpoint, { captureContent: false }),
    client(endpoint, { apiKey: "hue_setup_synthetic" }),
    client(endpoint, {
      redact: (_value: string, path: string) =>
        path.includes("hue.file.sha256") ? "removed" : _value,
    }),
  ];
  try {
    for (const [index, hueClient] of clients.entries()) {
      await hueClient.withSpan(`private file ${index}`, ({ span }) => {
        hueClient.recordFile({
          role: "input",
          mediaType: "image/png",
          data: Buffer.from([1, 2, 3]),
          upload: true,
        });
        if (index !== 2)
          span.setAttribute("gen_ai.input.messages", messageWithImage(Buffer.from([1, 2, 3])));
      });
      const report = await hueClient.flush();
      expect(report.uploadFallbacks).toBe(index === 2 ? 1 : 0);
    }
    expect(endpoint.reservations).toHaveLength(0);
  } finally {
    for (const hueClient of clients) await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

function mediaState(hueClient: ReturnType<typeof client>) {
  return (hueClient as unknown as { transport: HueTransport }).transport as unknown as {
    mediaMemo: {
      entries: Map<string, unknown>;
      units: number;
      bytes(bytes: Uint8Array, traceId: string): { sha256: string; size: number };
    };
    media: Map<string, { bytes: Uint8Array }[]>;
    mediaOwners: Map<string, { source: WeakRef<Span> }>;
    mediaTimer?: ReturnType<typeof setInterval>;
    heldBytes: number;
    uploadReports: Set<Promise<void>>;
    uploader: {
      unsupportedUntil: number;
      retryDelayMillis: number;
      lifetimeMillis: number;
      queued: number;
      pendingBytes(): number;
      store(
        traceId: string,
        key: string,
        value: string | Uint8Array,
        contentType: string,
        digest: { sha256: string; size: number },
        upload: { deadline: number; wait(ms: number): Promise<boolean> },
      ): Promise<{ ok: true; contentType: string } | { ok: false; reason: string }>;
      closed: boolean;
      outcomes: Map<string, { settled: boolean }>;
      requests: Set<unknown>;
    };
  };
}

function attachedMediaClient(
  endpoint: { url: string },
  liveSpans: boolean,
  tracked = true,
  eventCountLimit = 128,
) {
  const transport = createHueTransport({
    apiKey,
    serviceName: "media-lifecycle-tests",
    captureContent: true,
    baseUrl: endpoint.url,
    liveSpans,
  });
  const tracerProvider = new TracerProvider({
    spanLimits: { eventCountLimit },
    spanProcessors: tracked
      ? [
          {
            onStart: (span, parent) => transport.spanProcessor.onStart(span, parent),
            onEnd: (span) => {
              if (!span.name.startsWith("filtered")) transport.spanProcessor.onEnd(span);
            },
            forceFlush: () => transport.spanProcessor.forceFlush(),
            shutdown: () => transport.spanProcessor.shutdown(),
          },
        ]
      : [],
  });
  const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
  const hueClient = createHue({ transport, tracerProvider, loggerProvider });
  return {
    hueClient,
    async shutdown() {
      await hueClient.shutdown();
      await tracerProvider.shutdown();
      await loggerProvider.shutdown();
      await transport.shutdown();
    },
  };
}

/** Uploads retried after 10 ms, then 20 ms, instead of a second and two. */
function fastRetries(hueClient: ReturnType<typeof client>) {
  mediaState(hueClient).uploader.retryDelayMillis = 10;
}

/** The receiver is taken to lack the upload route from now on: values admission already held
 * whole are refused when their records are placed, and keep their fallback form. */
function refuseAtPlacement(hueClient: ReturnType<typeof client>) {
  mediaState(hueClient).uploader.unsupportedUntil = Date.now() + 60_000;
}

/** A store whose PUTs wait until `release()`; `entered` counts the PUTs that arrived. */
function putGate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = {
    entered: 0,
    release: () => release(),
    beforePut: async () => {
      gate.entered++;
      await opened;
    },
  };
  return gate;
}

async function waitForMedia(predicate: () => boolean, collect = false, millis = 3000) {
  const deadline = Date.now() + millis;
  do {
    // A dereferenced weak target stays alive through its current job. Collect on the next turn.
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (collect) Bun.gc(true);
    if (predicate()) return;
  } while (Date.now() < deadline);
  expect(predicate()).toBe(true);
}

for (const liveSpans of [false, true]) {
  test(`filtered ended spans release explicit media with liveSpans:${liveSpans}`, async () => {
    const endpoint = hue();
    const attached = attachedMediaClient(endpoint, liveSpans);
    const { hueClient } = attached;
    const bytes = Buffer.from("filtered file");
    const state = mediaState(hueClient);
    try {
      await hueClient.withSpan("filtered file", () => {
        hueClient.recordFile({ role: "input", mediaType: "image/png", data: bytes, upload: true });
        expect(state.media.size).toBe(1);
        expect(state.heldBytes).toBe(bytes.byteLength);
      });
      await waitForMedia(() => state.media.size === 0);
      expect(state.mediaOwners.size).toBe(0);
      expect(state.mediaTimer).toBeUndefined();
      expect(state.heldBytes).toBe(0);
      expect(endpoint.reservations).toHaveLength(0);
      await hueClient.withSpan("accepted after filter", () => {
        hueClient.recordFile({ role: "input", mediaType: "image/png", data: bytes, upload: true });
      });
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(1);
      expect(endpoint.completions).toHaveLength(1);
      expect(blobs(endpoint.span("accepted after filter")!)).toHaveLength(1);
      expect(state.heldBytes).toBe(0);
    } finally {
      await attached.shutdown();
      endpoint.server.stop(true);
    }
  });
}

test("recordFile uploads through an API-only span wrapper that does not expose its events", async () => {
  const endpoint = hue();
  const attached = attachedMediaClient(endpoint, false);
  const { hueClient } = attached;
  const bytes = Buffer.from("wrapped file");
  try {
    const inner = hueClient.tracer.startSpan("api-only wrapper");
    // The OpenTelemetry API contract only: everything forwards, nothing exposes `events`.
    const wrapper: Span = {
      spanContext: () => inner.spanContext(),
      setAttribute: (key, value) => (inner.setAttribute(key, value), wrapper),
      setAttributes: (attributes) => (inner.setAttributes(attributes), wrapper),
      addEvent: (name, attributes, time) => (inner.addEvent(name, attributes, time), wrapper),
      addLink: (link) => (inner.addLink(link), wrapper),
      addLinks: (links) => (inner.addLinks(links), wrapper),
      setStatus: (status) => (inner.setStatus(status), wrapper),
      updateName: (name) => (inner.updateName(name), wrapper),
      end: (time) => inner.end(time),
      isRecording: () => inner.isRecording(),
      recordException: (exception, time) => inner.recordException(exception, time),
    };
    hueClient.recordFile(
      { role: "input", mediaType: "image/png", data: bytes, upload: true },
      trace.setSpan(ROOT_CONTEXT, wrapper),
    );
    wrapper.end();
    const report = await hueClient.flush();
    expect(report.instrumentationFailures).toBe(0);
    expect(report.uploadFallbacks).toBe(0);
    expect(report.uploadedValues).toBe(1);
    const record = endpoint.span("api-only wrapper")!;
    expect(record.events?.map((event) => event.name)).toEqual(["hue.file"]);
    expect(blobs(record).map((entry) => entry.key)).toEqual([`event:hue.file:${sha256(bytes)}`]);
  } finally {
    await attached.shutdown();
    endpoint.server.stop(true);
  }
});

test("untracked media follows provider span lifetime when its safe wrapper is collected", async () => {
  const endpoint = hue();
  const attached = attachedMediaClient(endpoint, false, false);
  const { hueClient } = attached;
  const state = mediaState(hueClient);
  try {
    const wrapper = (() => {
      const span = hueClient.tracer.startSpan("untracked wrapper");
      hueClient.recordFile(
        { role: "input", mediaType: "image/png", data: Buffer.from([1, 2]), upload: true },
        trace.setSpan(ROOT_CONTEXT, span),
      );
      return new WeakRef(span);
    })();
    const source = state.mediaOwners.values().next().value!.source.deref()!;
    expect(source).toBeDefined();
    expect(source).not.toBe(wrapper.deref()!);
    await waitForMedia(() => wrapper.deref() === undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(state.media.size).toBe(1);
    expect(state.heldBytes).toBe(2);
    source.end();
    await waitForMedia(() => state.media.size === 0);
    expect(state.mediaOwners.size).toBe(0);
    expect(state.mediaTimer).toBeUndefined();
    expect(state.heldBytes).toBe(0);
    expect(endpoint.reservations).toHaveLength(0);
  } finally {
    await attached.shutdown();
    endpoint.server.stop(true);
  }
});

test("unreachable untracked spans release abandoned explicit media without ending", async () => {
  const endpoint = hue();
  const attached = attachedMediaClient(endpoint, false, false);
  const { hueClient } = attached;
  const state = mediaState(hueClient);
  try {
    (() => {
      const span = hueClient.tracer.startSpan("abandoned untracked");
      hueClient.recordFile(
        { role: "input", mediaType: "image/png", data: Buffer.from([1, 2]), upload: true },
        trace.setSpan(ROOT_CONTEXT, span),
      );
    })();
    expect(state.media.size).toBe(1);
    await waitForMedia(() => state.media.size === 0, true);
    expect(state.mediaOwners.size).toBe(0);
    expect(state.mediaTimer).toBeUndefined();
    expect(state.heldBytes).toBe(0);
    expect(endpoint.reservations).toHaveLength(0);
  } finally {
    await attached.shutdown();
    endpoint.server.stop(true);
  }
});

test("ordinary shutdown waits for in-flight media uploads after the span is sent, then closes the uploader", async () => {
  let releasePut!: () => void;
  let enteredPut = false;
  const gate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  const endpoint = hue({
    beforePut: async () => {
      enteredPut = true;
      await gate;
    },
  });
  const hueClient = client(endpoint);
  const state = mediaState(hueClient);
  const bytes = Buffer.from("in-flight media");
  try {
    await hueClient.withSpan("shutdown media", () => {
      hueClient.recordFile({ role: "input", mediaType: "image/png", data: bytes, upload: true });
    });
    let settled = false;
    const shutdown = hueClient.shutdown().finally(() => {
      settled = true;
    });
    await waitForMedia(() => enteredPut);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // The span was sent and released from the queue; only its upload holds the bytes.
    expect(endpoint.span("shutdown media")).toBeDefined();
    expect(settled).toBe(false);
    expect(state.uploader.closed).toBe(false);
    expect(state.media.size).toBe(0);
    expect(state.mediaOwners.size).toBe(0);
    expect(state.heldBytes).toBe(0);
    expect(state.uploader.pendingBytes()).toBe(bytes.byteLength);
    releasePut();
    const report = await shutdown;
    expect(report.uploadedValues).toBe(1);
    expect(report.acceptedSpans).toBe(1);
    expect(endpoint.completions).toHaveLength(1);
    expect([...endpoint.store.values()][0]!.bytes).toEqual(bytes);
    const record = endpoint.span("shutdown media")!;
    expect(record.events!.map((event) => event.name)).toEqual(["hue.file"]);
    expect(blobs(record)[0]!.sha256).toBe(sha256(bytes));
    expect(state.uploader.closed).toBe(true);
    expect(state.uploader.outcomes.size).toBe(0);
    expect(state.uploader.requests.size).toBe(0);
    expect(state.media.size).toBe(0);
    expect(state.heldBytes).toBe(0);
    expect(state.uploader.pendingBytes()).toBe(0);
    expect(state.mediaMemo.entries.size).toBe(0);
  } finally {
    releasePut();
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

for (const reserveStatus of [200, 403]) {
  test(`ordinary shutdown clears settled upload outcomes after reserve:${reserveStatus}`, async () => {
    const endpoint = hue(
      reserveStatus === 200 ? {} : { reserve: () => ({ status: reserveStatus }) },
    );
    const hueClient = client(endpoint);
    const state = mediaState(hueClient);
    try {
      await hueClient.withSpan("settled media", () => {
        hueClient.recordFile({
          role: "input",
          mediaType: "image/png",
          data: Buffer.from([1]),
          upload: true,
        });
      });
      await hueClient.flush();
      expect(state.uploader.outcomes.size).toBe(reserveStatus === 200 ? 1 : 0);
      expect([...state.uploader.outcomes.values()].every((outcome) => outcome.settled)).toBe(true);
      await hueClient.shutdown();
      expect(state.uploader.closed).toBe(true);
      expect(state.uploader.outcomes.size).toBe(0);
      expect(state.uploader.requests.size).toBe(0);
      expect(state.mediaOwners.size).toBe(0);
      expect(state.mediaMemo.entries.size).toBe(0);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });
}

test("default and private file helpers retain no payload memo and shutdown clears authorized media", async () => {
  const endpoint = hue();
  const normal = client(endpoint);
  const privateClient = client(endpoint, { captureContent: false });
  try {
    for (const [hueClient, upload] of [
      [normal, false],
      [privateClient, true],
    ] as const) {
      await hueClient.withSpan("memo privacy", () => {
        hueClient.recordFile({
          role: "input",
          mediaType: "image/png",
          data: Buffer.from("private payload"),
          upload,
        });
      });
      expect(mediaState(hueClient).mediaMemo.entries.size).toBe(0);
      expect(mediaState(hueClient).media.size).toBe(0);
    }
    await normal.withSpan("authorized memo", () => {
      normal.recordFile({
        role: "input",
        mediaType: "image/png",
        data: Buffer.from([1, 2, 3]),
        upload: true,
      });
    });
    expect(mediaState(normal).mediaMemo.entries.size).toBe(1);
    await normal.shutdown();
    expect(mediaState(normal).mediaMemo.entries.size).toBe(0);
    expect(mediaState(normal).mediaMemo.units).toBe(0);
    expect(mediaState(normal).media.size).toBe(0);
    expect(mediaState(normal).heldBytes).toBe(0);
  } finally {
    await normal.shutdown();
    await privateClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("explicit upload missing bytes and staging refusals retain file metadata and report failures", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const bytes = Buffer.from([1]);
  try {
    await hueClient.withSpan("staging cap", () => {
      for (let index = 0; index < 65; index++)
        hueClient.recordFile({ role: "input", mediaType: "image/png", data: bytes, upload: true });
      expect(mediaState(hueClient).media.values().next().value).toHaveLength(64);
      expect(mediaState(hueClient).mediaMemo.entries.size).toBe(1);
      hueClient.recordFile({
        role: "input",
        mediaType: "image/png",
        sha256: sha256(bytes),
        upload: true,
      });
    });
    await hueClient.flushSafe();
    expect(endpoint.span("staging cap")!.events).toHaveLength(66);
    expect(hueClient.transport.getReport().uploadFallbacks).toBe(2);
    expect(hueClient.transport.getReport().instrumentationFailures).toBe(2);
    expect(endpoint.reservations).toHaveLength(1);
    await hueClient.withSpan("held budget", () => {
      const state = mediaState(hueClient);
      state.heldBytes = 128 * MiB;
      hueClient.recordFile({ role: "input", mediaType: "image/png", data: bytes, upload: true });
      state.heldBytes = 0;
      expect(state.media.size).toBe(0);
    });
    mediaState(hueClient).uploader.unsupportedUntil = Date.now() + 60_000;
    await hueClient.withSpan("unavailable upload", () => {
      hueClient.recordFile({ role: "input", mediaType: "image/png", data: bytes, upload: true });
    });
    await hueClient.flushSafe();
    expect(hueClient.transport.getReport().uploadFallbacks).toBe(4);
    expect(hueClient.transport.getReport().instrumentationFailures).toBe(4);
    expect(
      hueClient.transport.getIssues().filter((issue) => issue.kind === "warning"),
    ).toHaveLength(4);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("abandoned explicit media is bounded by span identities without retaining span objects", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const transport = (hueClient as unknown as { transport: StagingTransport }).transport;
  const bytes = Buffer.from([1]);
  try {
    for (let index = 1; index <= 2049; index++) {
      const span = {
        spanContext: () => ({
          traceId: "1".repeat(32),
          spanId: index.toString(16).padStart(16, "0"),
        }),
      };
      const staged = transport.stageMedia(span, {
        bytes,
        digest: { sha256: sha256(bytes), size: 1 },
        contentType: "image/png",
      });
      expect(staged).toBe(index <= 2048);
    }
    const state = mediaState(hueClient);
    expect(state.media.size).toBe(2048);
    expect(state.heldBytes).toBe(2048);
    expect([...state.media.keys()].every((key) => typeof key === "string")).toBe(true);
    expect(hueClient.transport.getReport().uploadFallbacks).toBe(1);
    await hueClient.shutdown();
    expect(state.media.size).toBe(0);
    expect(state.heldBytes).toBe(0);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

function storeMedia(
  hueClient: ReturnType<typeof client>,
  bytes: Uint8Array,
  traceId = "1".repeat(32),
) {
  return mediaState(hueClient).uploader.store(
    traceId,
    `event:hue.file:${sha256(bytes)}`,
    bytes,
    "image/png",
    { sha256: sha256(bytes), size: bytes.byteLength },
    { deadline: Date.now() + 500, wait: async () => false },
  );
}

function setDecodedLimit(hueClient: ReturnType<typeof client>, decodedBytes: number) {
  const transport = hueClient.transport as unknown as {
    limits: { decodedBytes: number; requestBytes: number; valueBytes: number };
  };
  transport.limits = { ...transport.limits, decodedBytes };
}

test("409 exists successes are memoized while pending uploads deduplicate per trace", async () => {
  const bytes = Buffer.from("memoized existing media");
  const endpoint = hue({
    reserve: () => ({
      status: 409,
      body: JSON.stringify({
        status: "exists",
        ref: {
          key: "existing",
          sha256: sha256(bytes),
          size: bytes.length,
          content_type: "image/png",
        },
      }),
    }),
  });
  const hueClient = client(endpoint);
  try {
    const results = await Promise.all([storeMedia(hueClient, bytes), storeMedia(hueClient, bytes)]);
    expect(results).toEqual([
      { ok: true, contentType: "image/png" },
      { ok: true, contentType: "image/png" },
    ]);
    expect(await storeMedia(hueClient, bytes)).toEqual(results[0]);
    expect(endpoint.reservations).toHaveLength(1);
    expect(endpoint.puts).toHaveLength(0);
    expect(mediaState(hueClient).uploader.outcomes.size).toBe(1);
    expect((await storeMedia(hueClient, bytes, "2".repeat(32))).ok).toBe(true);
    expect(endpoint.reservations).toHaveLength(2);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const uploading = hue({ beforePut: () => held });
  const uploadingClient = client(uploading);
  try {
    const first = storeMedia(uploadingClient, bytes);
    await waitForMedia(() => uploading.reservations.length === 1);
    const second = storeMedia(uploadingClient, bytes);
    expect(mediaState(uploadingClient).uploader.outcomes.size).toBe(1);
    release();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(uploading.reservations).toHaveLength(1);
    expect(uploading.puts).toHaveLength(1);
    expect(uploading.completions).toHaveLength(1);
  } finally {
    release();
    await uploadingClient.shutdown();
    uploading.server.stop(true);
  }
});

test("a failed upload is not cached: the next reference to the same bytes tries again", async () => {
  const endpoint = hue({ reserve: (index) => ({ status: index === 1 ? 503 : 200 }) });
  const hueClient = client(endpoint);
  const bytes = Buffer.from("retry this media");
  try {
    // `storeMedia` never waits to try again: its one reservation fails.
    expect((await storeMedia(hueClient, bytes)).ok).toBe(false);
    const state = mediaState(hueClient);
    expect(state.uploader.outcomes.size).toBe(0);
    expect((await storeMedia(hueClient, bytes)).ok).toBe(true);
    expect(endpoint.reservations).toHaveLength(2);
    // A success is remembered.
    expect((await storeMedia(hueClient, bytes)).ok).toBe(true);
    expect(endpoint.reservations).toHaveLength(2);
    expect(state.uploader.outcomes.size).toBe(1);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("empty values never reserve and HTTP 400 isolates only the refused payload", async () => {
  for (const path of ["reserve", "put", "complete"] as const) {
    const behavior: Behavior =
      path === "reserve"
        ? { reserve: (index) => ({ status: index === 1 ? 400 : 200 }) }
        : path === "put"
          ? { put: (index) => (index === 1 ? 400 : 200) }
          : { complete: (index) => (index === 1 ? 400 : 200) };
    const endpoint = hue(behavior);
    const hueClient = client(endpoint);
    try {
      const state = mediaState(hueClient);
      expect((await storeMedia(hueClient, Buffer.alloc(0))).ok).toBe(false);
      expect(endpoint.reservations).toHaveLength(0);
      expect(state.uploader.outcomes.size).toBe(0);
      expect((await storeMedia(hueClient, Buffer.from("first payload"))).ok).toBe(
        path === "complete",
      );
      expect((await storeMedia(hueClient, Buffer.from("next valid payload"))).ok).toBe(true);
      expect(endpoint.reservations).toHaveLength(2);
      expect(endpoint.completions.at(-1)?.sha256).toBe(sha256("next valid payload"));
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  }
});

test("a transient PUT fails only its value, and a failed completion never fails or stops uploads", async () => {
  for (const path of ["put", "complete"] as const) {
    for (const status of [429, 503]) {
      const endpoint = hue(path === "put" ? { put: () => status } : { complete: () => status });
      const hueClient = client(endpoint);
      try {
        const first = await storeMedia(hueClient, Buffer.from("transient first payload"));
        expect(first.ok).toBe(path === "complete");
        expect((await storeMedia(hueClient, Buffer.from("next payload"))).ok).toBe(
          path === "complete",
        );
        // Nothing pauses: the next payload is reserved and tried.
        expect(endpoint.reservations).toHaveLength(2);
        expect(endpoint.completions).toHaveLength(path === "complete" ? 2 : 0);
      } finally {
        await hueClient.shutdown();
        endpoint.server.stop(true);
      }
    }
  }
});

test("file helper names enforce UTF-16 units and omit invalid names without dropping the event or upload", async () => {
  const names = [
    "🎧".repeat(128),
    "🎧".repeat(129),
    "🎧".repeat(256),
    " \t ",
    "a\u0000b",
    "a\u007fb",
    "a\ud800b",
    "a\udc00b",
  ];
  const endpoint = hue();
  const hueClient = client(endpoint);
  const bytes = Buffer.from("named media");
  try {
    for (const [index, name] of names.entries()) {
      await hueClient.withSpan(`name boundary ${index}`, () => {
        hueClient.recordFile({
          role: "output",
          mediaType: "audio/mpeg",
          name,
          data: bytes,
          upload: true,
        });
      });
    }
    await expect(hueClient.flush()).rejects.toThrow("Hue could not accept all telemetry");
    const report = hueClient.transport.getReport();
    expect(report.instrumentationFailures).toBe(names.length - 1);
    expect(report.uploadedValues).toBe(names.length);
    for (const [index, name] of names.entries()) {
      const span = endpoint.span(`name boundary ${index}`)!;
      expect(span.events).toHaveLength(1);
      expect(span.events![0]!.name).toBe("hue.file");
      expect(attr(span.events![0]! as WireRecord, "hue.file.name")?.stringValue).toBe(
        index === 0 ? name : undefined,
      );
      expect(blobs(span)).toHaveLength(1);
      expect(blobs(span)[0]!.name).toBe(index === 0 ? name : undefined);
    }
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("dropped helper events cannot authorize uploads through a same-digest metadata-only event", async () => {
  const endpoint = hue();
  const attached = attachedMediaClient(endpoint, false, true, 1);
  const bytes = Buffer.from("same digest different events");
  try {
    await attached.hueClient.withSpan("evicted upload event", () => {
      attached.hueClient.recordFile({
        role: "input",
        mediaType: "image/png",
        name: "upload.png",
        data: bytes,
        upload: true,
      });
      attached.hueClient.recordFile({
        role: "input",
        mediaType: "image/png",
        name: "metadata.png",
        data: bytes,
      });
    });
    const report = await attached.hueClient.flush();
    const span = endpoint.span("evicted upload event")!;
    expect(span.events).toHaveLength(1);
    expect(attr(span.events![0]! as WireRecord, "hue.file.name")?.stringValue).toBe("metadata.png");
    expect(endpoint.reservations).toHaveLength(0);
    expect(blobs(span)).toHaveLength(0);
    expect(report.uploadFallbacks).toBe(1);
    expect(
      attached.hueClient.transport.getIssues().filter((issue) => issue.kind === "warning"),
    ).toHaveLength(1);
    expect(mediaState(attached.hueClient).heldBytes).toBe(0);
  } finally {
    await attached.shutdown();
    endpoint.server.stop(true);
  }
});

test("partial helper event survival uploads one named reference without duplicates", async () => {
  const endpoint = hue();
  const attached = attachedMediaClient(endpoint, false, true, 1);
  const bytes = Buffer.from("duplicate bytes named separately");
  try {
    await attached.hueClient.withSpan("one surviving file", () => {
      attached.hueClient.recordFile({
        role: "input",
        mediaType: "image/png",
        name: "dropped.png",
        data: bytes,
        upload: true,
      });
      attached.hueClient.recordFile({
        role: "input",
        mediaType: "image/png",
        name: "surviving.png",
        data: bytes,
        upload: true,
      });
    });
    const report = await attached.hueClient.flush();
    const span = endpoint.span("one surviving file")!;
    expect(blobs(span)).toEqual([
      {
        key: `event:hue.file:${sha256(bytes)}`,
        sha256: sha256(bytes),
        size: bytes.length,
        content_type: "image/png",
        name: "surviving.png",
      },
    ]);
    expect(endpoint.reservations).toHaveLength(1);
    expect(endpoint.puts).toHaveLength(1);
    expect(report.uploadedValues).toBe(1);
    expect(report.uploadFallbacks).toBe(1);
  } finally {
    await attached.shutdown();
    endpoint.server.stop(true);
  }
});

test("helper fitting preserves an identical baseline reference while shedding content", async () => {
  const endpoint = hue();
  const attached = attachedMediaClient(endpoint, false);
  const bytes = Buffer.from("baseline collision media");
  const entry = {
    key: `event:hue.file:${sha256(bytes)}`,
    sha256: sha256(bytes),
    size: bytes.length,
    content_type: "image/png",
    name: "collision.png",
  };
  setDecodedLimit(attached.hueClient, 2048);
  try {
    await attached.hueClient.withSpan("baseline collision", ({ span }) => {
      span.setAttribute("hue.blobs", [JSON.stringify(entry)]);
      span.setAttribute("gen_ai.prompt", "X".repeat(8 * KiB));
      attached.hueClient.recordFile({
        role: "output",
        mediaType: "image/png",
        name: entry.name,
        data: bytes,
        upload: true,
      });
    });
    const report = await attached.hueClient.flush();
    const span = endpoint.span("baseline collision")!;
    expect(blobs(span)).toEqual([entry, entry]);
    expect(strings(attr(span, "hue.truncated"))).toContain("gen_ai.prompt");
    expect(endpoint.reservations).toHaveLength(1);
    expect(endpoint.puts).toHaveLength(1);
    expect(endpoint.completions).toHaveLength(1);
    expect(report.uploadedValues).toBe(1);
    expect(report.uploadFallbacks).toBe(0);
    expect(endpoint.decodedRequests.every((request) => request.bytes <= 2048)).toBe(true);
  } finally {
    await attached.shutdown();
    endpoint.server.stop(true);
  }
});

test("identical surviving helper events keep two references with one upload", async () => {
  const endpoint = hue();
  const attached = attachedMediaClient(endpoint, false);
  const bytes = Buffer.from("identical helper media");
  try {
    await attached.hueClient.withSpan("identical surviving files", () => {
      for (let index = 0; index < 2; index++) {
        attached.hueClient.recordFile({
          role: "output",
          mediaType: "image/png",
          name: "same.png",
          data: bytes,
          upload: true,
        });
      }
    });
    const report = await attached.hueClient.flush();
    const span = endpoint.span("identical surviving files")!;
    expect(span.events).toHaveLength(2);
    const entries = blobs(span);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(entries[1]);
    expect(entries[0]?.name).toBe("same.png");
    expect(endpoint.reservations).toHaveLength(1);
    expect(endpoint.puts).toHaveLength(1);
    expect(endpoint.completions).toHaveLength(1);
    expect(report.uploadedValues).toBe(2);
    expect(report.uploadFallbacks).toBe(0);
  } finally {
    await attached.shutdown();
    endpoint.server.stop(true);
  }
});

test("a helper span rejected by the request budget falls back once without uploading", async () => {
  const endpoint = hue();
  const attached = attachedMediaClient(endpoint, false);
  setDecodedLimit(attached.hueClient, 2048);
  try {
    await attached.hueClient.withSpan("unfittable file span", ({ span }) => {
      span.setAttribute("custom.metadata", "X".repeat(4 * KiB));
      attached.hueClient.recordFile({
        role: "output",
        mediaType: "image/png",
        data: Buffer.from("unfittable media"),
        upload: true,
      });
    });
    await expect(attached.hueClient.flush()).rejects.toThrow("Hue could not accept all telemetry");
    const report = attached.hueClient.transport.getReport();
    expect(report.failedSpans).toBe(1);
    expect(report.uploadedValues).toBe(0);
    expect(report.uploadFallbacks).toBe(1);
    expect(endpoint.span("unfittable file span")).toBeUndefined();
    expect(endpoint.reservations).toHaveLength(0);
    expect(endpoint.puts).toHaveLength(0);
    expect(
      attached.hueClient.transport.getIssues().filter((issue) => issue.kind === "warning"),
    ).toHaveLength(1);
    expect(mediaState(attached.hueClient).heldBytes).toBe(0);
  } finally {
    await attached.shutdown();
    endpoint.server.stop(true);
  }
});

test("each entry names its own reference's content type, even when Hue stores the bytes under another", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const bytes = randomBytes(2048);
  try {
    let traceId = "";
    await hueClient.withSpan("as an image", async ({ span }) => {
      traceId = span.spanContext().traceId;
      await hueClient.withSpan("as an attachment", (child) => {
        child.setInput({ file: new Attachment({ data: bytes, contentType: "image/png" }) });
      });
      await hueClient.flush();
      // Forgotten, as an outcome past the uploader's 4096 may be: Hue is asked again, and answers
      // that it stores the bytes, as image/png.
      mediaState(hueClient).uploader.outcomes.clear();
      span.setAttribute(
        "input.value",
        JSON.stringify({
          file: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
        }),
      );
    });
    await hueClient.flush();
    expect(endpoint.reservations.map((body) => body.contentType)).toEqual([
      "image/png",
      "application/octet-stream",
    ]);
    expect(endpoint.puts).toHaveLength(1);
    expect(endpoint.store.get(`${traceId}/${sha256(bytes)}`)!.contentType).toBe("image/png");
    expect(blobs(endpoint.span("as an attachment")!)).toEqual([
      { key: "input.value#/file", sha256: sha256(bytes), size: 2048, content_type: "image/png" },
    ]);
    expect(blobs(endpoint.span("as an image")!)).toEqual([
      {
        key: "input.value#/file",
        sha256: sha256(bytes),
        size: 2048,
        content_type: "application/octet-stream",
      },
    ]);
    expect(hueClient.transport.getReport().uploadedValues).toBe(2);
    // The import stores each value before it places it, and lists the type Hue stores it as.
    const uploader = new BlobUploader({
      baseUrl: endpoint.url,
      apiKey,
      timeoutMillis: 10_000,
      allowInsecureHttp: false,
      userAgent: "blob-tests",
    });
    try {
      const tally = newTally();
      const imported = await offloadAttributes(
        {},
        {
          candidates: [],
          cut: [],
          attachments: [
            {
              bytes,
              digest: { sha256: sha256(bytes), size: bytes.byteLength },
              contentType: "application/octet-stream",
              key: "input.value#/file",
            },
          ],
        },
        {
          uploader,
          traceId,
          valueBytes: MiB,
          upload: { deadline: Date.now() + 60_000, wait: async () => false },
          tally,
        },
      );
      expect(imported["hue.blobs"]).toEqual([
        JSON.stringify({
          key: "input.value#/file",
          sha256: sha256(bytes),
          size: 2048,
          content_type: "image/png",
        }),
      ]);
      expect(tally.uploaded).toBe(1);
    } finally {
      uploader.close();
    }
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("media digest memo retains only trace and SHA keys with bounded digest metadata", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  try {
    const state = mediaState(hueClient);
    const bytes = Buffer.from("customer-payload-canary\u0000\u00ff");
    const traceId = "1".repeat(32);
    const first = state.mediaMemo.bytes(bytes, traceId);
    expect(state.mediaMemo.bytes(bytes, traceId)).toBe(first);
    expect([...state.mediaMemo.entries.keys()]).toEqual([`${traceId}:${sha256(bytes)}`]);
    expect([...state.mediaMemo.entries.values()]).toEqual([
      { sha256: sha256(bytes), size: bytes.length },
    ]);
    state.mediaMemo.bytes(bytes, "2".repeat(32));
    expect(state.mediaMemo.entries.size).toBe(2);
    for (let index = 0; index < 4200; index++)
      state.mediaMemo.bytes(Buffer.from(String(index)), traceId);
    expect(state.mediaMemo.entries.size).toBeLessThanOrEqual(4096);
    expect(state.mediaMemo.units).toBeLessThanOrEqual(32 * MiB);
    expect(
      [...state.mediaMemo.entries.keys()].every((key) => /^[0-9a-f]{32}:[0-9a-f]{64}$/.test(key)),
    ).toBe(true);
    await hueClient.shutdown();
    expect(state.mediaMemo.entries.size).toBe(0);
    expect(state.mediaMemo.units).toBe(0);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("helper uploads from several spans run four at a time after their spans are sent", async () => {
  // Twelve 600 ms uploads need 7.2 s one at a time, and about 1.8 s through the four shared
  // workers.
  let active = 0;
  let peak = 0;
  // Whether every span had arrived when each upload's PUT ended.
  const sent: boolean[] = [];
  const endpoint = hue({
    beforePut: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 600));
      sent.push(files.every((_, index) => endpoint.span(`concurrent helper ${index}`)));
      active--;
    },
  });
  const files = Array.from({ length: 13 }, (_, index) => Buffer.from(`concurrent helper ${index}`));
  const shed = sha256(files[12]!);
  const hueClient = client(endpoint, {
    timeoutMillis: 1000,
    // The last span's event loses its digest, so its file has no surviving event to attach to.
    redact: (value: string) => (value === shed ? "removed" : value),
  });
  try {
    for (const [index, data] of files.entries())
      await hueClient.withSpan(`concurrent helper ${index}`, () => {
        hueClient.recordFile({ role: "input", mediaType: "image/png", data, upload: true });
      });
    const started = Date.now();
    const report = await hueClient.flush();
    expect(Date.now() - started).toBeLessThan(6000);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(sent).toHaveLength(12);
    expect(sent.every(Boolean)).toBe(true);
    expect(report.uploadedValues).toBe(12);
    expect(report.uploadFallbacks).toBe(1);
    expect(endpoint.reservations.map((reservation) => reservation.sha256).sort()).toEqual(
      files
        .slice(0, 12)
        .map((data) => sha256(data))
        .sort(),
    );
    for (const [index, data] of files.entries())
      expect(blobs(endpoint.span(`concurrent helper ${index}`)!).map((entry) => entry.key)).toEqual(
        index < 12 ? [`event:hue.file:${sha256(data)}`] : [],
      );
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
}, 20_000);

test("requested helper uploads of spans dropped at the queue count as upload fallbacks", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint, { maxQueueBytes: 1024 });
  try {
    for (let index = 0; index < 6; index++)
      await hueClient.withSpan(`dropped helper ${index}`, ({ span }) => {
        // Over the whole queue budget: the span is dropped when it ends.
        span.setAttribute("app.padding", "x".repeat(2048));
        hueClient.recordFile({
          role: "input",
          mediaType: "image/png",
          data: Buffer.from(`dropped helper ${index}`),
          upload: true,
        });
      });
    await hueClient.flushSafe();
    const report = hueClient.transport.getReport();
    expect(report.droppedSpans).toBe(6);
    expect(report.uploadFallbacks).toBe(6);
    expect(endpoint.reservations).toHaveLength(0);
    expect(mediaState(hueClient).heldBytes).toBe(0);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("per-record media inspection counts UTF-16 code units", async () => {
  // Each message is about 3.5 M code units but 7 MB of UTF-8: three fit the 16 MiB per-record
  // inspection bound only when counted in code units, so the last message's image is found.
  const endpoint = hue();
  const hueClient = client(endpoint);
  // "image" makes every message a candidate for inspection, charged to the record's bound.
  const filler = `Describe this image. ${"é".repeat(3_500_000)}`;
  const image = Buffer.alloc(4096, 7);
  const message = (withImage: boolean) =>
    JSON.stringify([
      {
        role: "user",
        parts: [
          { type: "text", content: filler },
          ...(withImage
            ? [
                {
                  type: "blob",
                  modality: "image",
                  mime_type: "image/png",
                  content: image.toString("base64"),
                },
              ]
            : []),
        ],
      },
    ]);
  try {
    await hueClient.withSpan("utf-16 inspection", ({ span }) => {
      span.setAttribute("gen_ai.input.messages", message(false));
      span.setAttribute("gen_ai.output.messages", message(false));
      span.setAttribute("ai.prompt.messages", message(true));
    });
    await hueClient.flush();
    const record = endpoint.span("utf-16 inspection")!;
    expect(blobs(record).map((entry) => entry.key)).toEqual([
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "ai.prompt.messages#/0/parts/1",
      "ai.prompt.messages",
    ]);
    expect(blobs(record)[2]!.sha256).toBe(sha256(image));
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("a message of 8 Mi code units is inspected even when its UTF-8 is longer", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const image = Buffer.alloc(4096, 9);
  const messages = [
    {
      role: "user",
      parts: [{ type: "blob", mime_type: "image/png", content: image.toString("base64") }],
      padding: "",
    },
  ];
  messages[0]!.padding = "é".repeat(8 * MiB - JSON.stringify(messages).length);
  const value = JSON.stringify(messages);
  expect(value.length).toBe(8 * MiB);
  expect(Buffer.byteLength(value, "utf8")).toBeGreaterThan(8 * MiB);
  try {
    await hueClient.withSpan("utf-16 message bound", ({ span }) => {
      span.setAttribute("gen_ai.input.messages", value);
    });
    await hueClient.flush();
    const record = endpoint.span("utf-16 message bound")!;
    expect(blobs(record).map((entry) => entry.key)).toEqual([
      "gen_ai.input.messages#/0/parts/0",
      "gen_ai.input.messages",
    ]);
    expect(blobs(record)[0]!.sha256).toBe(sha256(image));
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("export leaves uninspected the messages admission skipped", async () => {
  // The held-value budget is full, so the first two ~6 Mi-unit messages are inspected and shrink
  // to digests when queued. The third is past the 16 Mi per-record allowance and is queued as
  // recorded; export must not inspect it either, though the first two are now short.
  const endpoint = hue();
  const hueClient = client(endpoint, { maxQueueBytes: 64 * MiB });
  const state = mediaState(hueClient);
  const transport = hueClient.transport as unknown as {
    limits: { decodedBytes: number; requestBytes: number; valueBytes: number };
  };
  transport.limits = {
    ...transport.limits,
    decodedBytes: 64 * MiB,
    requestBytes: 64 * MiB,
    valueBytes: 16 * MiB,
  };
  // The first two messages are mostly a 4.5 MiB image (6 Mi base64 characters); the third is
  // 6 Mi characters of text and a small image.
  const images = [Buffer.alloc(4.5 * MiB, 1), Buffer.alloc(4.5 * MiB, 2), Buffer.alloc(4096, 3)];
  const message = (image: Buffer, index: number) =>
    JSON.stringify([
      {
        role: "user",
        parts: [
          { type: "text", content: index === 2 ? "x".repeat(6 * MiB) : "Describe this image." },
          {
            type: "blob",
            modality: "image",
            mime_type: "image/png",
            content: image.toString("base64"),
          },
        ],
      },
    ]);
  const keys = ["gen_ai.input.messages", "gen_ai.output.messages", "ai.prompt.messages"];
  const messages = images.map(message);
  state.heldBytes = 128 * MiB;
  try {
    await hueClient.withSpan("skipped at admission", ({ span }) => {
      for (const [index, key] of keys.entries()) span.setAttribute(key, messages[index]!);
    });
    state.heldBytes = 0;
    await hueClient.flush();
    const record = endpoint.span("skipped at admission")!;
    for (const index of [0, 1])
      expect(JSON.parse(attr(record, keys[index]!)!.stringValue!)[0].parts[1]).toEqual({
        type: "blob",
        modality: "image",
        mime_type: "image/png",
        sha256: sha256(images[index]!),
        size: images[index]!.length,
      });
    expect(attr(record, "ai.prompt.messages")!.stringValue).toBe(messages[2]);
    expect(blobs(record)).toEqual([]);
    expect(endpoint.reservations).toHaveLength(0);
  } finally {
    state.heldBytes = 0;
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("repeated files share one upload without holding the slots new files need", async () => {
  // Twelve spans each record four copies of their own file. A one-second request timeout gives
  // a six-second upload budget: 600 ms uploads take 7.2 s when each span's copies fill the four
  // slots, and about 1.8 s when only each file's first reference takes one.
  let active = 0;
  let peak = 0;
  const endpoint = hue({
    beforePut: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 600));
      active--;
    },
  });
  const files = Array.from({ length: 12 }, (_, index) => Buffer.from(`repeated file ${index}`));
  const hueClient = client(endpoint, { timeoutMillis: 1000 });
  try {
    for (const [index, data] of files.entries())
      await hueClient.withSpan(`repeated file ${index}`, () => {
        for (let copy = 0; copy < 4; copy++)
          hueClient.recordFile({ role: "input", mediaType: "image/png", data, upload: true });
      });
    const started = Date.now();
    const report = await hueClient.flush();
    expect(Date.now() - started).toBeLessThan(6000);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(report.uploadFallbacks).toBe(0);
    expect(report.uploadedValues).toBe(48);
    expect(endpoint.reservations.map((reservation) => reservation.sha256).sort()).toEqual(
      files.map((data) => sha256(data)).sort(),
    );
    expect(endpoint.puts).toHaveLength(12);
    for (const [index, data] of files.entries())
      expect(blobs(endpoint.span(`repeated file ${index}`)!).map((entry) => entry.key)).toEqual(
        Array(4).fill(`event:hue.file:${sha256(data)}`),
      );
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
}, 20_000);

/** An OTLP `AnyValue`, as the synthetic receiver decodes it, as JSON. */
function json(value: Value | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.kvlistValue)
    return Object.fromEntries(value.kvlistValue.values.map(({ key, value }) => [key, json(value)]));
  if (value.arrayValue) return value.arrayValue.values.map(json);
  return null;
}

describe("attachments", () => {
  const { files, cases } = corpus.attachments;
  type FileSpec = { data: string; content_type: string; name?: string };
  /** The case's value with each `{ $attachment }` placeholder replaced by one attachment per
   * file, the same instance wherever the file appears. */
  const build = (value: unknown, made = new Map<string, Attachment>()): unknown => {
    if (Array.isArray(value)) return value.map((item) => build(item, made));
    if (value && typeof value === "object") {
      const named = (value as { $attachment?: string }).$attachment;
      if (named !== undefined) {
        const spec = (files as Record<string, FileSpec>)[named]!;
        if (!made.has(named))
          made.set(
            named,
            new Attachment({
              data: Buffer.from(spec.data, "base64"),
              contentType: spec.content_type,
              ...(spec.name ? { name: spec.name } : {}),
            }),
          );
        return made.get(named);
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, build(item, made)]),
      );
    }
    return value;
  };
  const record = async (hueClient: HueClient, id: string, helper: string, value: unknown) => {
    const placed = build(value);
    if (helper === "model")
      await hueClient.model("synthetic-model", () => undefined, {
        provider: "synthetic",
        name: id,
        input: placed,
      });
    else if (helper === "metadata")
      await hueClient.withSpan(id, () => undefined, {
        attributes: { metadata: placed as Attachment },
      });
    else
      await hueClient.withSpan(id, (span) => {
        if (helper === "input") span.setInput(placed);
        if (helper === "output") span.setOutput(placed);
        if (helper === "log") hueClient.recordMessages({ input: placed });
      });
  };

  for (const mode of MODES)
    test(`shared attachment wire ${mode}`, async () => {
      const endpoint = modeEndpoint(mode);
      const hueClient = client(endpoint);
      try {
        for (const item of cases) await record(hueClient, item.id, item.helper, item.value);
        if (mode === "refused") refuseAtPlacement(hueClient);
        const report = await hueClient.flush();
        const expected = cases.reduce((total, item) => total + item.entries.length, 0);
        expect(report.instrumentationFailures).toBe(0);
        expect(report.uploadedValues).toBe(mode === "success" ? expected : 0);
        expect(report.uploadFallbacks).toBe(mode === "success" ? 0 : expected);
        if (mode === "late failure") expectLateFailures(hueClient, expected);
        for (const item of cases) {
          const span = endpoint.span(item.id)!;
          let carrier: WireRecord = span;
          if (item.helper === "log") {
            carrier = endpoint.logs().find((log) => log.traceId === span.traceId)!;
            expect(json(carrier.body)).toEqual(item.recorded);
          } else
            expect(attr(span, item.attribute)!.stringValue).toBe(JSON.stringify(item.recorded));
          expect(strings(attr(carrier, "hue.blobs")) ?? []).toEqual(
            mode === "refused" ? [] : item.entries,
          );
        }
        // The same file twice in one trace is stored once.
        if (mode === "success")
          expect(endpoint.puts.length).toBe(
            new Set(endpoint.reservations.map((r) => `${String(r.traceId)}:${String(r.sha256)}`))
              .size,
          );
      } finally {
        await hueClient.shutdown();
        endpoint.server.stop(true);
      }
    });

  test("bytes over 25 MiB are refused before they are copied", () => {
    const large = new Uint8Array(25 * MiB + 1);
    const copies = { view: 0, buffer: 0 };
    const viewSlice = Uint8Array.prototype.slice;
    const bufferSlice = ArrayBuffer.prototype.slice;
    Uint8Array.prototype.slice = function (this: Uint8Array, ...args: [number?, number?]) {
      copies.view++;
      return viewSlice.apply(this, args);
    } as typeof viewSlice;
    ArrayBuffer.prototype.slice = function (this: ArrayBuffer, begin: number, end?: number) {
      copies.buffer++;
      return bufferSlice.call(this, begin, end);
    } as typeof bufferSlice;
    try {
      for (const data of [large, large.buffer, new DataView(large.buffer)]) {
        const attachment = new Attachment({ data, contentType: "application/pdf" });
        expect(attachment.sha256).toBeUndefined();
      }
    } finally {
      Uint8Array.prototype.slice = viewSlice;
      ArrayBuffer.prototype.slice = bufferSlice;
    }
    expect(copies).toEqual({ view: 0, buffer: 0 });
  });

  test("a path reads the same bytes as data, and every string form decodes", () => {
    const bytes = Buffer.from(files.pixel.data, "base64");
    const directory = mkdtempSync(join(tmpdir(), "hue-attachment-"));
    const path = join(directory, "pixel.png");
    writeFileSync(path, bytes);
    const forms = [
      new Attachment({ path, contentType: "image/png" }),
      new Attachment({ data: bytes, contentType: "image/png" }),
      new Attachment({
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        contentType: "image/png",
      }),
      new Attachment({ data: files.pixel.data, contentType: "image/png" }),
      new Attachment({
        data: `data:image/png;base64,${files.pixel.data}`,
        contentType: "image/png",
      }),
    ];
    for (const attachment of forms) {
      expect(attachment.sha256).toBe(sha256(bytes));
      expect(attachment.size).toBe(bytes.byteLength);
    }
    // The bytes are copied when the attachment is made.
    const copy = Buffer.from(bytes);
    const made = new Attachment({ data: copy, contentType: "image/png" });
    copy.fill(0);
    expect(made.sha256).toBe(sha256(bytes));
    for (const invalid of [
      new Attachment({ contentType: "image/png" }),
      new Attachment({ data: bytes, path, contentType: "image/png" }),
      new Attachment({ path: join(directory, "missing.png"), contentType: "image/png" }),
      new Attachment({ data: "not base64!", contentType: "image/png" }),
      new Attachment({ data: bytes, contentType: "image png" }),
      new Attachment({ data: Buffer.alloc(25 * MiB + 1), contentType: "image/png" }),
    ])
      expect(invalid.sha256).toBeUndefined();
    expect(
      new Attachment({ data: bytes, contentType: "image/png", name: "a\tb" }).name,
    ).toBeUndefined();
  });

  test("an invalid attachment records null and an invalid name is omitted, both counted", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const bytes = Buffer.from(files.pixel.data, "base64");
    try {
      await hueClient.withSpan(
        "invalid",
        (span) => {
          span.setInput({
            bad: new Attachment({ data: bytes, contentType: "not a type" }),
            unnamed: new Attachment({ data: bytes, contentType: "image/png", name: "bad\nname" }),
          });
          span.setOutput("kept");
        },
        { attributes: { metadata: new Attachment({ contentType: "image/png" }), plain: "kept" } },
      );
      // Instrumentation failures fail the flush; the span is exported whole all the same.
      await expect(hueClient.flush()).rejects.toThrow();
      const report = hueClient.transport.getReport();
      expect(report.instrumentationFailures).toBe(3);
      expect(report.acceptedSpans).toBe(1);
      const span = endpoint.span("invalid")!;
      expect(JSON.parse(attr(span, "input.value")!.stringValue!)).toEqual({
        bad: null,
        unnamed: {
          type: "blob",
          mime_type: "image/png",
          modality: "image",
          sha256: sha256(bytes),
          size: bytes.byteLength,
        },
      });
      expect(attr(span, "output.value")!.stringValue).toBe('"kept"');
      expect(attr(span, "plain")!.stringValue).toBe("kept");
      expect(attr(span, "metadata")).toBeUndefined();
      expect(blobs(span).map((entry) => entry.key)).toEqual(["input.value#/unnamed"]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("without content capture a metadata attachment is its digest part and no bytes leave", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint, { captureContent: false });
    const bytes = Buffer.from(files.report.data, "base64");
    const attachment = new Attachment({
      data: bytes,
      contentType: "application/pdf",
      name: "report.pdf",
    });
    try {
      await hueClient.withSpan(
        "metadata only",
        (span) => {
          span.setInput({ report: attachment });
          hueClient.recordMessages({ input: [attachment] });
        },
        { attributes: { metadata: { report: attachment } } },
      );
      const report = await hueClient.flush();
      const span = endpoint.span("metadata only")!;
      expect(JSON.parse(attr(span, "metadata")!.stringValue!)).toEqual({
        report: {
          type: "blob",
          mime_type: "application/pdf",
          modality: "document",
          sha256: sha256(bytes),
          size: bytes.byteLength,
        },
      });
      expect(attr(span, "input.value")).toBeUndefined();
      expect(attr(span, "hue.blobs")).toBeUndefined();
      expect(endpoint.logs()).toEqual([]);
      expect(endpoint.reservations).toEqual([]);
      expect(report.uploadFallbacks).toBe(0);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("an attachment the redactor removes, replaces or nests too deep is not uploaded", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint, {
      redact: (value: string, path: string) =>
        path === "attributes.output.value" ? "[redacted]" : value,
    });
    const bytes = Buffer.from(files.pixel.data, "base64");
    const attachment = new Attachment({ data: bytes, contentType: "image/png" });
    let deep: unknown = attachment;
    for (let level = 0; level < 11; level++) deep = [deep];
    try {
      await hueClient.withSpan("redacted", (span) => {
        span.setOutput([attachment]);
        span.setInput({ first: attachment });
        // Setting the value again replaces the attachments it held.
        span.setInput("no file now");
        span.span.setAttribute("custom", "x");
      });
      await hueClient.withSpan("deep", (span) => span.setInput(deep));
      const report = await hueClient.flush();
      expect(endpoint.reservations).toEqual([]);
      expect(attr(endpoint.span("redacted")!, "hue.blobs")).toBeUndefined();
      expect(attr(endpoint.span("redacted")!, "output.value")!.stringValue).toBe("[redacted]");
      // Only the part past Hue's reading depth is reported: it kept its digest.
      expect(report.uploadFallbacks).toBe(1);
      expect(attr(endpoint.span("deep")!, "input.value")!.stringValue).toContain(sha256(bytes));
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("an attachment in a value that uploads whole is still uploaded and listed", async () => {
    // With its file as the digest part, the value is still over the 1 MiB value limit: it
    // uploads whole and keeps its first 16 KiB inline. The attachment's bytes are stored and
    // listed all the same, so they can be read by digest, though no reader places the part in
    // the value's inline prefix.
    const endpoint = hue();
    const hueClient = client(endpoint);
    const bytes = Buffer.from(files.pixel.data, "base64");
    const pixel = new Attachment({ data: bytes, contentType: "image/png", name: "pixel.png" });
    try {
      await hueClient.withSpan("uploads whole", (span) =>
        span.setInput({ notes: "n".repeat(2 * MiB), image: pixel }),
      );
      const report = await hueClient.flush();
      expect([report.uploadedValues, report.uploadFallbacks]).toEqual([2, 0]);
      const record = endpoint.span("uploads whole")!;
      expect(strings(attr(record, "hue.truncated"))).toEqual(["input.value"]);
      expect(blobs(record).map((entry) => entry.key)).toEqual([
        "input.value",
        "input.value#/image",
      ]);
      expect(blobs(record)[1]).toEqual({
        key: "input.value#/image",
        sha256: sha256(bytes),
        size: bytes.byteLength,
        content_type: "image/png",
        name: "pixel.png",
      });
      const traceId = Buffer.from(record.traceId, "base64").toString("hex");
      expect(endpoint.store.get(`${traceId}/${sha256(bytes)}`)?.bytes).toEqual(bytes);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("setup credentials record the digest part and upload nothing", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint, { apiKey: "hue_setup_synthetic" });
    try {
      await hueClient.withSpan("setup", (span) =>
        span.setInput([new Attachment({ data: Buffer.from("abcd"), contentType: "text/plain" })]),
      );
      const report = await hueClient.flush();
      expect(endpoint.reservations).toEqual([]);
      expect(report.uploadFallbacks).toBe(0);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });
});

/** An OTLP value as the JSON it carries (a kvlist as an object). */
function jsonOf(value: Value | undefined): unknown {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  const double = (value as { doubleValue?: number }).doubleValue;
  if (double !== undefined) return double;
  if (value.kvlistValue)
    return Object.fromEntries(
      (value.kvlistValue.values ?? []).map(({ key, value: item }) => [key, jsonOf(item)]),
    );
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(jsonOf);
  return null;
}

type LogCase = {
  id: string;
  input?: unknown;
  output?: unknown;
  success: { body: unknown; entries: string[] };
  failure: { body: unknown; entries: string[] };
};

const hex = (base64: string) => Buffer.from(base64, "base64").toString("hex");

for (const item of (corpus as unknown as { logs: LogCase[] }).logs) {
  for (const mode of MODES) {
    test(`log media wire ${mode}: ${item.id}`, async () => {
      const endpoint = modeEndpoint(mode);
      const hueClient = client(endpoint);
      try {
        let traceId = "";
        await hueClient.withSpan(item.id, ({ span }) => {
          traceId = span.spanContext().traceId;
          hueClient.recordMessages({
            ...(item.input !== undefined ? { input: item.input } : {}),
            ...(item.output !== undefined ? { output: item.output } : {}),
            operation: "chat",
            provider: "openai",
            model: item.id,
          });
        });
        if (mode === "refused") refuseAtPlacement(hueClient);
        const report = await hueClient.flush();
        const [log] = endpoint.logs();
        expect(hex(log!.traceId)).toBe(traceId);
        expect(jsonOf(log!.body)).toEqual(item[form(mode)].body);
        expect(strings(attr(log!, "hue.blobs")) ?? []).toEqual(item[form(mode)].entries);
        expect(attr(endpoint.span(item.id)!, "hue.blobs")).toBeUndefined();
        if (mode === "success") {
          expect(report.uploadedValues).toBe(item.success.entries.length);
          // Each file's bytes are stored under the log record's own trace.
          for (const entry of item.success.entries) {
            const { sha256: digest } = JSON.parse(entry) as { sha256: string };
            expect(sha256(endpoint.store.get(`${traceId}/${digest}`)!.bytes)).toBe(digest);
          }
          expect(
            endpoint.reservations.every((reservation) => reservation.traceId === traceId),
          ).toBe(true);
        } else if (mode === "late failure")
          expectLateFailures(hueClient, item.success.entries.length);
        else expect(report.uploadFallbacks).toBe(item.success.entries.length);
      } finally {
        await hueClient.shutdown();
        endpoint.server.stop(true);
      }
    });
  }
}

describe("media beyond the recorded messages", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII=",
    "base64",
  );
  const dataUrl = (bytes: Buffer, type = "image/png") =>
    `data:${type};base64,${bytes.toString("base64")}`;
  /** A log record emitted through the client's logger, correlated with `span`. */
  const emit = (
    hueClient: ReturnType<typeof client>,
    span: Span,
    record: { body?: unknown; attributes?: Record<string, string>; eventName?: string },
  ) =>
    (hueClient as unknown as { logger: { emit(record: unknown): void } }).logger.emit({
      ...record,
      context: trace.setSpan(ROOT_CONTEXT, span),
    });

  test("metadata-only export inspects and uploads nothing, and records no inference log", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint, { captureContent: false });
    try {
      await hueClient.withSpan("metadata only", ({ span }) => {
        span.setAttribute("metadata", dataUrl(png));
        span.setAttribute("input.value", JSON.stringify({ image: dataUrl(png) }));
        hueClient.recordMessages({ input: [{ role: "user", content: dataUrl(png) }] });
      });
      await hueClient.flush();
      const record = endpoint.span("metadata only")!;
      expect(attr(record, "metadata")!.stringValue).toBe(dataUrl(png));
      expect(attr(record, "input.value")).toBeUndefined();
      expect(attr(record, "hue.blobs")).toBeUndefined();
      expect(endpoint.logs()).toEqual([]);
      expect(endpoint.reservations).toEqual([]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a value past the per-attribute inspection limit has its media read in place", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const large = Buffer.alloc(6 * MiB + 1, 7);
    try {
      await hueClient.withSpan("over inspection", ({ span }) => {
        span.setAttribute("input.value", JSON.stringify({ image: dataUrl(large) }));
      });
      await hueClient.flush();
      const record = endpoint.span("over inspection")!;
      // Over 8 Mi code units of text: its image is read in place and uploaded as a file, where
      // 0.18.1 uploaded the whole value as text.
      expect(blobs(record).map(({ key, content_type }) => [key, content_type])).toEqual([
        ["input.value#/image", "image/png"],
      ]);
      expect(JSON.parse(attr(record, "input.value")!.stringValue!)).toEqual({
        image: {
          type: "blob",
          mime_type: "image/png",
          modality: "image",
          sha256: sha256(large),
          size: large.byteLength,
        },
      });
      expect(attr(record, "hue.truncated")).toBeUndefined();
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a correlated log record uploads its inspected attributes' and GenAI body's media", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const messages = messageWithImage(png);
    try {
      let traceId = "";
      await hueClient.withSpan("correlated", ({ span }) => {
        traceId = span.spanContext().traceId;
        emit(hueClient, span, {
          body: messages,
          attributes: { "gen_ai.input.messages": messages, "custom.messages": messages },
        });
        // A deprecated GenAI event names its one message's parts from the body.
        emit(hueClient, span, {
          eventName: "gen_ai.user.message",
          body: {
            content: [
              { type: "text", text: "Look." },
              { type: "image_url", image_url: { url: dataUrl(png) } },
            ],
          },
        });
      });
      await hueClient.flush();
      const [attributeLog, eventLog] = endpoint.logs();
      // A body that is JSON text, and an attribute Hue does not read files from, stay as recorded.
      expect(attributeLog!.body!.stringValue).toBe(messages);
      expect(attr(attributeLog!, "custom.messages")!.stringValue).toBe(messages);
      expect(
        JSON.parse(attr(attributeLog!, "gen_ai.input.messages")!.stringValue!)[0].parts[1],
      ).toEqual({
        type: "blob",
        modality: "image",
        mime_type: "image/png",
        sha256: sha256(png),
        size: png.byteLength,
      });
      expect(blobs(attributeLog!)).toEqual([
        {
          key: "gen_ai.input.messages#/0/parts/1",
          sha256: sha256(png),
          size: png.byteLength,
          content_type: "image/png",
        },
      ]);
      expect(jsonOf(eventLog!.body)).toEqual({
        content: [
          { type: "text", text: "Look." },
          { type: "image_url", image_url: {}, sha256: sha256(png), size: png.byteLength },
        ],
      });
      expect(blobs(eventLog!).map(({ key }) => key)).toEqual(["body#/content/1"]);
      expect(endpoint.store.has(`${traceId}/${sha256(png)}`)).toBe(true);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("an inference log over the value cap is recorded when its files account for the excess", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const image = randomBytes(2 * MiB);
    try {
      await hueClient.withSpan("large inference log", () => {
        hueClient.recordMessages({
          input: [
            {
              role: "user",
              parts: [{ type: "blob", mime_type: "image/png", content: image.toString("base64") }],
            },
          ],
          operation: "chat",
          provider: "openai",
        });
        // Text past the cap with no file to upload is refused, as before.
        hueClient.recordMessages({ input: [{ role: "user", content: "t".repeat(2 * MiB) }] });
      });
      await hueClient.flush().catch(() => undefined);
      expect(hueClient.transport.getReport().instrumentationFailures).toBe(1);
      const [log] = endpoint.logs();
      expect(endpoint.logs()).toHaveLength(1);
      expect(jsonOf(log!.body)).toEqual({
        "gen_ai.input.messages": [
          {
            role: "user",
            parts: [
              {
                type: "blob",
                mime_type: "image/png",
                sha256: sha256(image),
                size: image.byteLength,
              },
            ],
          },
        ],
      });
      expect(blobs(log!).map(({ key }) => key)).toEqual(["body#/gen_ai.input.messages/0/parts/0"]);
      expect(attr(log!, "hue.truncated")).toBeUndefined();
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });
});

describe("one upload step for a log record's files", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII=",
    "base64",
  );
  const pdf = Buffer.from("%PDF-1.4\n%synthetic attachment\n%%EOF\n");
  const imagePart = { type: "blob", modality: "image", mime_type: "image/png" };
  const pdfPart = {
    type: "blob",
    mime_type: "application/pdf",
    modality: "document",
    sha256: sha256(pdf),
    size: pdf.byteLength,
    name: "terms.pdf",
  };

  for (const mode of MODES)
    test(`an attachment and inline media in one body upload together, once each: ${mode}`, async () => {
      const endpoint = modeEndpoint(mode);
      const hueClient = client(endpoint);
      try {
        let traceId = "";
        await hueClient.withSpan("one log step", ({ span }) => {
          traceId = span.spanContext().traceId;
          hueClient.recordMessages({
            input: [
              {
                role: "user",
                parts: [
                  { ...imagePart, content: png.toString("base64") },
                  new Attachment({ data: pdf, contentType: "application/pdf", name: "terms.pdf" }),
                ],
              },
            ],
            operation: "chat",
            provider: "openai",
          });
        });
        if (mode === "refused") refuseAtPlacement(hueClient);
        const report = await hueClient.flush();
        const [log] = endpoint.logs();
        const parts = (jsonOf(log!.body) as { "gen_ai.input.messages": { parts: unknown[] }[] })[
          "gen_ai.input.messages"
        ][0]!.parts;
        // The attachment is its digest part either way; the small image is placed unless it is
        // refused when the record is placed, and then stays inline as before.
        expect(parts[1]).toEqual(pdfPart);
        expect(parts[0]).toEqual(
          mode === "refused"
            ? { ...imagePart, content: png.toString("base64") }
            : { ...imagePart, sha256: sha256(png), size: png.byteLength },
        );
        expect(attr(endpoint.span("one log step")!, "hue.blobs")).toBeUndefined();
        // Each file is reserved once, by the one step that places a log record's files; none is
        // reserved once refused.
        const keys = endpoint.reservations.map((body) => String(body.key));
        const expected = [
          "body#/gen_ai.input.messages/0/parts/0",
          "body#/gen_ai.input.messages/0/parts/1",
        ];
        if (mode === "refused") expect(keys).toEqual([]);
        else expect(keys.sort()).toEqual(expected);
        expect(endpoint.reservations.every((body) => body.traceId === traceId)).toBe(true);
        if (mode !== "refused") {
          expect(blobs(log!)).toEqual([
            {
              key: "body#/gen_ai.input.messages/0/parts/0",
              sha256: sha256(png),
              size: png.byteLength,
              content_type: "image/png",
            },
            {
              key: "body#/gen_ai.input.messages/0/parts/1",
              sha256: sha256(pdf),
              size: pdf.byteLength,
              content_type: "application/pdf",
              name: "terms.pdf",
            },
          ]);
          if (mode === "success") {
            expect(endpoint.puts).toHaveLength(2);
            expect(report.uploadedValues).toBe(2);
            expect(report.uploadFallbacks).toBe(0);
          } else expectLateFailures(hueClient, 2);
        } else {
          expect(attr(log!, "hue.blobs")).toBeUndefined();
          expect(report.uploadedValues).toBe(0);
          expect(report.uploadFallbacks).toBe(2);
        }
      } finally {
        await hueClient.shutdown();
        endpoint.server.stop(true);
      }
    });

  test("a log record's message file that is not uploaded keeps the nested 64 KiB rule", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const large = Buffer.from(Array.from({ length: 100 * 1024 }, (_, index) => (index * 7) % 256));
    const messages = JSON.stringify([
      {
        role: "user",
        parts: [
          { ...imagePart, content: png.toString("base64") },
          { ...imagePart, content: large.toString("base64") },
        ],
      },
    ]);
    try {
      await hueClient.withSpan("log fallback", ({ span }) => {
        (hueClient as unknown as { logger: { emit(record: unknown): void } }).logger.emit({
          body: "log fallback",
          attributes: { "gen_ai.input.messages": messages },
          context: trace.setSpan(ROOT_CONTEXT, span),
        });
      });
      refuseAtPlacement(hueClient);
      const report = await hueClient.flush();
      const [log] = endpoint.logs();
      // Both uploads were refused: the small image stays inline and the large one is its digest,
      // as a log record's messages were before log records uploaded.
      expect(JSON.parse(attr(log!, "gen_ai.input.messages")!.stringValue!)[0].parts).toEqual([
        { ...imagePart, content: png.toString("base64") },
        { ...imagePart, sha256: sha256(large), size: large.byteLength },
      ]);
      expect(attr(log!, "hue.blobs")).toBeUndefined();
      expect(endpoint.reservations).toEqual([]);
      expect(report.uploadFallbacks).toBe(2);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });
});

test("a log body's file the queue cut is exported cut, never uploaded as a shorter file", async () => {
  // Over the per-attribute inspection limit, the base64 is not held whole: the queue cuts it, and
  // its cut (a multiple of four characters) still reads as base64, which must not upload.
  const endpoint = hue();
  const hueClient = client(endpoint);
  const data = "A".repeat(8 * MiB + 4);
  try {
    await hueClient.withSpan("cut log body", ({ span }) => {
      (hueClient as unknown as { logger: { emit(record: unknown): void } }).logger.emit({
        eventName: "gen_ai.user.message",
        body: {
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
        },
        context: trace.setSpan(ROOT_CONTEXT, span),
      });
    });
    const report = await hueClient.flush();
    const [log] = endpoint.logs();
    // Cut, the body is still over the value limit: it is replaced by the receiver's marker, as
    // before log records uploaded, and nothing of the image is stored or listed.
    expect(JSON.stringify(jsonOf(log!.body))).not.toContain("sha256");
    expect(strings(attr(log!, "hue.truncated"))).toEqual(["body"]);
    expect(attr(log!, "hue.blobs")).toBeUndefined();
    expect(endpoint.reservations).toEqual([]);
    expect(report.uploadedValues).toBe(0);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("span attributes OpenTelemetry cannot hold are recorded as JSON text, as attachments are", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  try {
    await hueClient.withSpan("json attributes", () => undefined, {
      attributes: {
        metadata: { customer: "acme", plan: { seats: 3 } },
        records: [{ id: 1 }, { id: 2 }],
        mixed: [1, "two"],
        tags: ["a", "b"],
        count: 2,
      },
    });
    await hueClient.flush();
    const record = endpoint.span("json attributes")!;
    expect(attr(record, "metadata")!.stringValue).toBe('{"customer":"acme","plan":{"seats":3}}');
    expect(attr(record, "records")!.stringValue).toBe('[{"id":1},{"id":2}]');
    expect(attr(record, "mixed")!.stringValue).toBe('[1,"two"]');
    // Values OpenTelemetry holds stay as they are.
    expect(strings(attr(record, "tags"))).toEqual(["a", "b"]);
    expect(Number(attr(record, "count")!.intValue)).toBe(2);
    expect(endpoint.reservations).toEqual([]);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("input.value declared text/plain stays literal text; a JSON one is read for files", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII=",
    "base64",
  );
  const value = JSON.stringify({ image: `data:image/png;base64,${png.toString("base64")}` });
  try {
    await hueClient.withSpan("literal", ({ span }) => {
      span.setAttribute("input.mime_type", "text/plain");
      span.setAttribute("input.value", value);
      span.setAttribute("output.mime_type", "application/json");
      span.setAttribute("output.value", value);
    });
    await hueClient.flush();
    const record = endpoint.span("literal")!;
    // OpenInference's text/plain value is literal text to Hue, so it is left as recorded.
    expect(attr(record, "input.value")!.stringValue).toBe(value);
    expect(blobs(record).map(({ key }) => key)).toEqual(["output.value#/image"]);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("a JSON attribute recorded as a raw data: URL is its file; other text that is no JSON stays", async () => {
  // A Langfuse SDK records a string input or output as it is, not as JSON. Hue reads text that
  // does not parse as the text itself, and a whole data: URL as a file.
  const endpoint = hue();
  const hueClient = client(endpoint);
  const wav = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), randomBytes(4 * KiB)]);
  const png = randomBytes(2 * KiB);
  const untouched = {
    "langfuse.observation.input": "Transcribe the attached call, then summarise it.",
    "langfuse.trace.input": `{not JSON "data:image/png;base64,${png.toString("base64")}"}`,
    "langfuse.trace.output": `Image: data:image/png;base64,${png.toString("base64")}`,
    "output.value": "data:,a data: URL without a media type",
  };
  try {
    await hueClient.withSpan("raw data url", ({ span }) => {
      span.setAttribute(
        "langfuse.observation.output",
        `data:audio/wav;base64,${wav.toString("base64")}`,
      );
      span.setAttribute("input.value", `data:image/png;base64,${png.toString("base64")}`);
      for (const [key, value] of Object.entries(untouched)) span.setAttribute(key, value);
    });
    const report = await hueClient.flush();
    expect([report.uploadedValues, report.uploadFallbacks]).toEqual([2, 0]);
    const record = endpoint.span("raw data url")!;
    // Each is placed as the digest-form part of a whole-value file, listed under `<attribute>#`.
    expect(JSON.parse(attr(record, "langfuse.observation.output")!.stringValue!)).toEqual({
      type: "blob",
      mime_type: "audio/wav",
      modality: "audio",
      sha256: sha256(wav),
      size: wav.byteLength,
    });
    expect(JSON.parse(attr(record, "input.value")!.stringValue!)).toEqual({
      type: "blob",
      mime_type: "image/png",
      modality: "image",
      sha256: sha256(png),
      size: png.byteLength,
    });
    expect(
      blobs(record)
        .map(({ key, sha256: digest, content_type }) => [key, digest, content_type])
        .sort(),
    ).toEqual([
      ["input.value#", sha256(png), "image/png"],
      ["langfuse.observation.output#", sha256(wav), "audio/wav"],
    ]);
    expect([...endpoint.store.values()].map(({ bytes }) => sha256(bytes)).sort()).toEqual(
      [sha256(png), sha256(wav)].sort(),
    );
    for (const [key, value] of Object.entries(untouched))
      expect(attr(record, key)!.stringValue).toBe(value);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("raw PCM whose type declares its format is reserved, listed and placed as Hue names it", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const [realtime, l16, stereo, extra, bare, declared, unsupported, chat, reply] = Array.from(
    { length: 9 },
    () => randomBytes(4 * KiB),
  );
  const url = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;
  const blob = (type: string, bytes: Buffer) => ({ type: "blob", content: url(type, bytes) });
  try {
    await hueClient.withSpan("pcm", ({ span }) => {
      span.setAttribute("langfuse.observation.output", url("audio/pcm;rate=24000", realtime));
      span.setAttribute(
        "gen_ai.input.messages",
        JSON.stringify([
          {
            role: "user",
            parts: [
              blob("audio/L16;rate=16000", l16),
              blob("audio/x-pcm;rate=8000;channels=2", stereo),
              blob("audio/pcm;rate=24000;bits=16", extra),
              blob("audio/pcm", bare),
              {
                type: "blob",
                mime_type: "audio/pcm;rate=16000",
                content: declared.toString("base64"),
              },
              {
                type: "blob",
                mime_type: "audio/pcm;channels=1",
                content: unsupported.toString("base64"),
              },
            ],
          },
        ]),
      );
      // OpenAI's pcm16 audio: 16-bit little-endian PCM at 24 kHz, mono.
      span.setAttribute(
        "input.value",
        JSON.stringify({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: { data: chat.toString("base64"), format: "pcm16" },
                },
              ],
            },
          ],
        }),
      );
      span.setAttribute(
        "gen_ai.output.messages",
        JSON.stringify([
          {
            role: "assistant",
            content: null,
            audio: { id: "audio_1", data: reply.toString("base64"), format: "pcm16" },
          },
        ]),
      );
    });
    await hueClient.flush();
    const record = endpoint.span("pcm")!;
    const types = {
      "langfuse.observation.output#": "audio/pcm;rate=24000;channels=1",
      "gen_ai.input.messages#/0/parts/0": "audio/L16;rate=16000;channels=1",
      "gen_ai.input.messages#/0/parts/1": "audio/pcm;rate=8000;channels=2",
      // A parameter Hue cannot honor, or no rate: the type it had before.
      "gen_ai.input.messages#/0/parts/2": "audio/pcm",
      "gen_ai.input.messages#/0/parts/3": "audio/pcm",
      "gen_ai.input.messages#/0/parts/4": "audio/pcm;rate=16000;channels=1",
      "gen_ai.input.messages#/0/parts/5": "audio/pcm;channels=1",
      "input.value#/messages/0/content/0": "audio/pcm;rate=24000;channels=1",
      "gen_ai.output.messages#/0": "audio/pcm;rate=24000;channels=1",
    };
    expect(
      Object.fromEntries(endpoint.reservations.map(({ key, contentType }) => [key, contentType])),
    ).toEqual(types);
    expect(
      Object.fromEntries(blobs(record).map((entry) => [entry.key, entry.content_type])),
    ).toEqual(types);
    // The whole value's part names the type; a provider part keeps its own fields.
    expect(JSON.parse(attr(record, "langfuse.observation.output")!.stringValue!)).toEqual({
      type: "blob",
      mime_type: "audio/pcm;rate=24000;channels=1",
      modality: "audio",
      sha256: sha256(realtime),
      size: realtime.byteLength,
    });
    expect(JSON.parse(attr(record, "input.value")!.stringValue!).messages[0].content[0]).toEqual({
      type: "input_audio",
      input_audio: { format: "pcm16" },
      sha256: sha256(chat),
      size: chat.byteLength,
    });
    expect(JSON.parse(attr(record, "gen_ai.output.messages")!.stringValue!)[0]).toEqual({
      role: "assistant",
      content: null,
      audio: { id: "audio_1", format: "pcm16" },
      sha256: sha256(reply),
      size: reply.byteLength,
    });
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("a log body's inline media take hue.blobs places before its attachments, in order", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const images = Array.from({ length: 66 }, (_, index) =>
    Buffer.from([0x89, 0x50, 0x4e, 0x47, index, index >> 8]),
  );
  try {
    await hueClient.withSpan("many files", () => {
      hueClient.recordMessages({
        input: [
          {
            role: "user",
            parts: [
              ...images.map((bytes) => ({
                type: "blob",
                mime_type: "image/png",
                content: bytes.toString("base64"),
              })),
              new Attachment({
                data: Buffer.from("%PDF-1.4 extra"),
                contentType: "application/pdf",
              }),
            ],
          },
        ],
        operation: "chat",
        provider: "openai",
      });
    });
    const report = await hueClient.flush();
    const [log] = endpoint.logs();
    // As on a span: the 64 places go to the inline media in reading order; the attachment and
    // the inline media past them stay as they are, counted as not uploaded.
    expect(blobs(log!).map(({ key }) => key)).toEqual(
      Array.from({ length: 64 }, (_, index) => `body#/gen_ai.input.messages/0/parts/${index}`),
    );
    expect(report.uploadFallbacks).toBe(3);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

test("a text/plain input.value over the cap still uploads whole, never read for media", async () => {
  const endpoint = hue();
  const hueClient = client(endpoint);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII=",
    "base64",
  );
  const value = JSON.stringify({
    image: `data:image/png;base64,${png.toString("base64")}`,
    text: "x".repeat(2 * MiB),
  });
  try {
    let traceId = "";
    await hueClient.withSpan("literal whole", ({ span }) => {
      traceId = span.spanContext().traceId;
      span.setAttribute("input.mime_type", "text/plain");
      span.setAttribute("input.value", value);
    });
    await hueClient.flush();
    const record = endpoint.span("literal whole")!;
    // Uploaded whole as any value over the cap is, its image left in the text.
    expect(blobs(record)).toEqual([
      {
        key: "input.value",
        sha256: sha256(value),
        size: Buffer.byteLength(value),
        content_type: "application/json",
      },
    ]);
    expect(endpoint.store.get(`${traceId}/${sha256(value)}`)!.bytes.toString("utf8")).toBe(value);
    expect(strings(attr(record, "hue.truncated"))).toEqual(["input.value"]);
  } finally {
    await hueClient.shutdown();
    endpoint.server.stop(true);
  }
});

/** A shared corpus case whose file is too long for the media inspection bounds: the file's bytes
 * are its seed repeated to its size, written as base64 or a `data:` URL where `$file` stands. */
type LargeCase = {
  id: string;
  attribute: string;
  file: string;
  form: "base64" | "dataUrl";
  messages?: unknown;
  value?: string;
  success: { messages?: unknown; value?: string; entries: string[] };
  failure: { messages?: unknown; value?: string; truncated?: boolean; entries: string[] };
};
const large = (
  corpus as unknown as {
    large: {
      files: Record<string, { seed: string; size: number; content_type: string }>;
      cases: LargeCase[];
    };
  }
).large;

function largeFile(name: string): Buffer {
  const { seed, size } = large.files[name]!;
  const bytes = Buffer.from(seed, "base64");
  return Buffer.concat(Array(Math.ceil(size / bytes.byteLength)).fill(bytes)).subarray(0, size);
}

/** A large case's attribute text: `$file` replaced by the file as the case writes it. */
function largeText(item: LargeCase): string {
  const data = largeFile(item.file).toString("base64");
  const content =
    item.form === "base64" ? data : `data:${large.files[item.file]!.content_type};base64,${data}`;
  const fill = (value: unknown): unknown =>
    value === "$file"
      ? content
      : Array.isArray(value)
        ? value.map(fill)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]))
          : value;
  return item.value !== undefined ? content : JSON.stringify(fill(item.messages));
}

describe("media past the inspection bounds", () => {
  for (const item of large.cases) {
    for (const mode of MODES) {
      test(`large media wire ${mode}: ${item.id}`, async () => {
        const endpoint = modeEndpoint(mode);
        const hueClient = client(endpoint);
        const text = largeText(item);
        // Past the per-attribute bound: 0.18.1 uploaded such a value whole, its file unread.
        expect(text.length).toBeGreaterThan(MAX_INLINE_FILE_TEXT);
        try {
          await hueClient.withSpan(item.id, ({ span }) => {
            span.setAttribute(item.attribute, text);
          });
          if (mode === "refused") refuseAtPlacement(hueClient);
          const report = await hueClient.flush();
          expect(report.acceptedSpans).toBe(1);
          const record = endpoint.span(item.id)!;
          const exported = attr(record, item.attribute)!.stringValue!;
          const expected = item[form(mode)];
          expect(strings(attr(record, "hue.blobs")) ?? []).toEqual(expected.entries);
          if ("truncated" in expected) {
            // Not a recorded message: the file keeps its bytes, and the value is cut as before.
            expect(strings(attr(record, "hue.truncated"))).toEqual([item.attribute]);
            expect(text.startsWith(exported)).toBe(true);
          } else if (expected.value !== undefined) expect(exported).toBe(expected.value);
          else expect(JSON.parse(exported)).toEqual(expected.messages);
          if (mode === "late failure") expectLateFailures(hueClient, expected.entries.length);
          if (mode === "success") {
            expect(report.uploadFallbacks).toBe(0);
            const [entry] = expected.entries.map(
              (value) => JSON.parse(value) as { sha256: string },
            );
            const traceId = Buffer.from(record.traceId!, "base64").toString("hex");
            expect(endpoint.store.get(`${traceId}/${entry!.sha256}`)!.bytes).toEqual(
              largeFile(item.file),
            );
          }
        } finally {
          await hueClient.shutdown();
          endpoint.server.stop(true);
        }
      });
    }
  }

  test("a model call's 10 MB audio part is read in place, its memory bounded by a slice", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const audio = largeFile("wav");
    const big = Buffer.concat([audio, audio.subarray(0, 4 * MiB)]);
    const input = [
      {
        role: "user",
        parts: [
          { type: "text", content: "Transcribe this call." },
          {
            type: "blob",
            modality: "audio",
            mime_type: "audio/wav",
            content: big.toString("base64"),
          },
        ],
      },
    ];
    const parse = JSON.parse;
    const from = Buffer.from;
    const largest = { parse: 0, decode: 0 };
    try {
      await hueClient.model("gpt-audio", () => "ok", { provider: "openai", input });
      JSON.parse = function (text: string, reviver?: Parameters<typeof parse>[1]) {
        largest.parse = Math.max(largest.parse, text.length);
        return parse(text, reviver);
      } as typeof JSON.parse;
      (Buffer as unknown as { from: (...args: unknown[]) => Buffer }).from = (...args) => {
        if (typeof args[0] === "string" && args[1] === "base64")
          largest.decode = Math.max(largest.decode, args[0].length);
        return (from as (...args: unknown[]) => Buffer).apply(Buffer, args);
      };
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(1);
      expect(report.uploadFallbacks).toBe(0);
    } finally {
      JSON.parse = parse;
      Buffer.from = from;
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
    // The message is never parsed whole, nor its file decoded whole: only the JSON around it and
    // 1 MiB slices of its base64.
    expect(largest.parse).toBeLessThan(64 * KiB);
    expect(largest.decode).toBeLessThanOrEqual(MiB);
    const record = endpoint.span("chat gpt-audio")!;
    expect(JSON.parse(attr(record, "gen_ai.input.messages")!.stringValue!)).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", content: "Transcribe this call." },
          {
            type: "blob",
            modality: "audio",
            mime_type: "audio/wav",
            sha256: sha256(big),
            size: big.byteLength,
          },
        ],
      },
    ]);
    expect(blobs(record)).toEqual([
      {
        key: "gen_ai.input.messages#/0/parts/1",
        sha256: sha256(big),
        size: big.byteLength,
        content_type: "audio/wav",
      },
    ]);
    expect(attr(record, "hue.truncated")).toBeUndefined();
  });

  test("a message past the record's inspection allowance is read in place too", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    // Three messages of 6 Mi code units: the third is past the record's 16 Mi allowance.
    const images = [1, 2, 3].map((seed) => Buffer.alloc(4_700_000, seed));
    const keys = ["gen_ai.input.messages", "gen_ai.output.messages", "ai.prompt.messages"];
    try {
      await hueClient.withSpan("allowance", ({ span }) => {
        keys.forEach((key, index) => span.setAttribute(key, messageWithImage(images[index]!)));
      });
      const report = await hueClient.flush();
      expect(report.uploadFallbacks).toBe(0);
      const record = endpoint.span("allowance")!;
      expect(blobs(record).map(({ key, sha256: digest }) => [key, digest])).toEqual(
        keys.map((key, index) => [`${key}#/0/parts/1`, sha256(images[index]!)]),
      );
      expect(attr(record, "hue.truncated")).toBeUndefined();
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a percent-escaped data: URL past the bounds is not read in place: it uploads whole", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    // 3 Mi escapes of 3 units each: 9 Mi code units, past the per-attribute bound.
    const block = Array.from(
      { length: 256 },
      (_, byte) => `%${byte.toString(16).padStart(2, "0")}`,
    ).join("");
    const messages = JSON.stringify([
      {
        role: "user",
        parts: [
          {
            type: "blob",
            modality: "audio",
            mime_type: "audio/wav",
            content: `data:audio/wav,${block.repeat((3 * MiB) / 256)}`,
          },
        ],
      },
    ]);
    try {
      await hueClient.withSpan("percent", ({ span }) => {
        span.setAttribute("gen_ai.input.messages", messages);
      });
      const report = await hueClient.flush();
      expect(report.uploadFallbacks).toBe(0);
      const record = endpoint.span("percent")!;
      // As 0.18.1 stored it: the whole value, its first 16 KiB inline.
      expect(blobs(record).map(({ key, content_type }) => [key, content_type])).toEqual([
        ["gen_ai.input.messages", "application/json"],
      ]);
      const traceId = Buffer.from(record.traceId!, "base64").toString("hex");
      expect(endpoint.store.get(`${traceId}/${sha256(messages)}`)!.bytes.toString()).toBe(messages);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a value whose JSON around its files is past the per-attribute bound uploads whole", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    // A text part of 9 Mi code units with escapes (newlines) is parsed, not read in place.
    const messages = JSON.stringify([
      {
        role: "user",
        parts: [
          { type: "text", content: "line\n".repeat((9 * MiB) / 5) },
          { type: "blob", modality: "image", mime_type: "image/png", content: "iVBORw0KGgo=" },
        ],
      },
    ]);
    try {
      await hueClient.withSpan("over the bound", ({ span }) => {
        span.setAttribute("gen_ai.input.messages", messages);
      });
      await hueClient.flush();
      const record = endpoint.span("over the bound")!;
      expect(blobs(record).map(({ key, content_type }) => [key, content_type])).toEqual([
        ["gen_ai.input.messages", "application/json"],
      ]);
      expect(strings(attr(record, "hue.truncated"))).toEqual(["gen_ai.input.messages"]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });
});

describe("files given by path over 25 MiB", () => {
  /** A sparse file of `size` bytes starting with `head`, removed after the test. */
  function sparseFile(size: number, head = "RIFF\0\0\0\0WAVE") {
    const directory = mkdtempSync(join(tmpdir(), "hue-path-file-"));
    const path = join(directory, "recording.wav");
    writeFileSync(path, head);
    truncateSync(path, size);
    return { path, remove: () => rmSync(directory, { recursive: true, force: true }) };
  }

  test("an attachment of a 30 MiB file uploads from disk, never held in memory", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const file = sparseFile(30 * MiB);
    try {
      const bytes = readFileSync(file.path);
      const attachment = new Attachment({
        path: file.path,
        contentType: "audio/wav",
        name: "call.wav",
      });
      expect(attachment.sha256).toBe(sha256(bytes));
      expect(attachment.size).toBe(30 * MiB);
      await hueClient.withSpan("path attachment", ({ setInput }) => {
        setInput({ recording: attachment });
      });
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(1);
      expect(report.uploadFallbacks).toBe(0);
      expect(report.instrumentationFailures).toBe(0);
      const record = endpoint.span("path attachment")!;
      expect(JSON.parse(attr(record, "input.value")!.stringValue!)).toEqual({
        recording: {
          type: "blob",
          mime_type: "audio/wav",
          modality: "audio",
          sha256: sha256(bytes),
          size: 30 * MiB,
          name: "call.wav",
        },
      });
      expect(blobs(record)).toEqual([
        {
          key: "input.value#/recording",
          sha256: sha256(bytes),
          size: 30 * MiB,
          content_type: "audio/wav",
          name: "call.wav",
        },
      ]);
      const traceId = Buffer.from(record.traceId!, "base64").toString("hex");
      expect(endpoint.store.get(`${traceId}/${sha256(bytes)}`)!.bytes.equals(bytes)).toBe(true);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
      file.remove();
    }
  });

  test("recordFile uploads a 30 MiB file given by path", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const file = sparseFile(30 * MiB);
    try {
      const bytes = readFileSync(file.path);
      await hueClient.withSpan("record path", () => {
        hueClient.recordFile({
          role: "input",
          mediaType: "audio/wav",
          path: file.path,
          upload: true,
          name: "call.wav",
        });
      });
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(1);
      expect(report.instrumentationFailures).toBe(0);
      const record = endpoint.span("record path")!;
      const event = record.events!.find(({ name }) => name === "hue.file")!;
      expect(event.attributes!.find(({ key }) => key === "hue.file.size")!.value.intValue).toBe(
        String(30 * MiB),
      );
      expect(blobs(record)).toEqual([
        {
          key: `event:hue.file:${sha256(bytes)}`,
          sha256: sha256(bytes),
          size: 30 * MiB,
          content_type: "audio/wav",
          name: "call.wav",
        },
      ]);
      const traceId = Buffer.from(record.traceId!, "base64").toString("hex");
      expect(endpoint.store.get(`${traceId}/${sha256(bytes)}`)!.bytes.equals(bytes)).toBe(true);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
      file.remove();
    }
  });

  for (const change of ["changed", "removed", "replaced by a named pipe"] as const)
    test(`a file ${change} after it was recorded is not uploaded, and is counted`, async () => {
      const endpoint = hue();
      const hueClient = client(endpoint);
      const file = sparseFile(30 * MiB);
      const digest = sha256(readFileSync(file.path));
      try {
        await hueClient.withSpan(change, ({ setInput }) => {
          setInput({ recording: new Attachment({ path: file.path, contentType: "audio/wav" }) });
          hueClient.recordFile({
            role: "input",
            mediaType: "audio/wav",
            path: file.path,
            upload: true,
          });
          if (change === "removed") file.remove();
          else if (change === "replaced by a named pipe") {
            // Opened without waiting for a writer, and refused as no regular file.
            rmSync(file.path);
            execFileSync("mkfifo", [file.path]);
          } else {
            // One byte in the middle: the size is the same, the SHA-256 is not.
            const descriptor = openSync(file.path, "r+");
            writeSync(descriptor, "X", 20 * MiB);
            closeSync(descriptor);
          }
        });
        const report = await hueClient.flush();
        // The attachment and the recorded file each read the file again and find it changed,
        // after the span went out listing both.
        expect(report.uploadedValues).toBe(0);
        expect(report.uploadFallbacks).toBe(2);
        const record = endpoint.span(change)!;
        expect(blobs(record).map(({ key }) => key)).toEqual([
          "input.value#/recording",
          `event:hue.file:${digest}`,
        ]);
        // The part keeps the digest it was recorded with.
        expect(JSON.parse(attr(record, "input.value")!.stringValue!).recording.size).toBe(30 * MiB);
        // Nothing was stored or completed, and no complete body of other bytes reached the store.
        expect(endpoint.store.size).toBe(0);
        expect(endpoint.completions).toEqual([]);
        expect(endpoint.puts.filter(({ status }) => status === 200)).toEqual([]);
        expect(
          hueClient.transport
            .getIssues()
            .some(({ message }) => message.includes("could not be uploaded")),
        ).toBe(true);
      } finally {
        await hueClient.shutdown();
        endpoint.server.stop(true);
        file.remove();
      }
    });

  test("a source starts fresh on each read: a file put back after a changed read uploads", async () => {
    const file = sparseFile(30 * MiB);
    try {
      const bytes = readFileSync(file.path);
      const source = fileSource({ path: file.path, size: bytes.byteLength, sha256: sha256(bytes) });
      const read = async () => {
        const hash = createHash("sha256");
        try {
          for await (const chunk of source.chunks()) hash.update(chunk);
          return hash.digest("hex");
        } catch {
          return undefined;
        }
      };
      writeFileSync(file.path, "changed");
      expect(await read()).toBeUndefined();
      expect(source.changed).toBe(true);
      writeFileSync(file.path, bytes);
      expect(await read()).toBe(sha256(bytes));
      expect(source.changed).toBe(false);
    } finally {
      file.remove();
    }
  });

  test("a success answered before the whole body was sent stores nothing", async () => {
    // A store that answers 200 as soon as a PUT arrives, before reading its body.
    const { createServer } = await import("node:http");
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/otlp/blobs") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const reservation = JSON.parse(body) as Record<string, unknown>;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              status: "upload",
              method: "PUT",
              url: `http://127.0.0.1:${(server.address() as { port: number }).port}/store`,
              headers: { "Content-Length": String(reservation.byteSize) },
              ref: { content_type: reservation.contentType },
            }),
          );
        });
        return;
      }
      response.writeHead(200);
      response.end();
      request.destroy();
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const uploader = new BlobUploader({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      apiKey,
      timeoutMillis: 10_000,
      allowInsecureHttp: false,
      userAgent: "blob-tests",
    });
    // A slow source: the answer arrives while the body is still being sent.
    const size = 8 * MiB;
    const source = {
      size,
      async *chunks() {
        for (let sent = 0; sent < size; sent += MiB) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          yield Buffer.alloc(MiB, 1);
        }
      },
    };
    try {
      const outcome = await uploader.store(
        "0123456789abcdef0123456789abcdef",
        "input.value#/a",
        source,
        "audio/wav",
        { sha256: sha256(Buffer.alloc(size, 1)), size },
        { deadline: Date.now() + 30_000, wait: async () => false },
      );
      expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    } finally {
      uploader.close();
      server.close();
    }
  });

  test("a file that changed does not fail another reference to the bytes it was recorded with", async () => {
    const endpoint = hue();
    const file = sparseFile(30 * MiB);
    const uploader = new BlobUploader({
      baseUrl: endpoint.url,
      apiKey,
      timeoutMillis: 10_000,
      allowInsecureHttp: false,
      userAgent: "blob-tests",
    });
    const traceId = "0123456789abcdef0123456789abcdef";
    const upload = { deadline: Date.now() + 60_000, wait: async () => false };
    try {
      const bytes = readFileSync(file.path);
      const digest = { sha256: sha256(bytes), size: bytes.byteLength };
      const source = fileSource({ path: file.path, ...digest });
      const descriptor = openSync(file.path, "r+");
      writeSync(descriptor, "X", 20 * MiB);
      closeSync(descriptor);
      // The changed file's upload starts first; the same bytes held in memory wait for it, and
      // then upload themselves rather than take its failure.
      const changed = uploader.store(
        traceId,
        "input.value#/a",
        source,
        "audio/wav",
        digest,
        upload,
      );
      const held = uploader.store(traceId, "input.value#/b", bytes, "audio/wav", digest, upload);
      expect(await changed).toMatchObject({ ok: false, reason: "failed" });
      expect(await held).toEqual({ ok: true, contentType: "audio/wav" });
      expect(endpoint.store.get(`${traceId}/${digest.sha256}`)!.bytes.equals(bytes)).toBe(true);
    } finally {
      uploader.close();
      endpoint.server.stop(true);
      file.remove();
    }
  });

  test("bytes over 25 MiB, and a file over Hue's 1 GB upload limit, are still refused", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const file = sparseFile(1_000_000_001);
    try {
      expect(new Attachment({ path: file.path, contentType: "audio/wav" }).sha256).toBeUndefined();
      expect(
        new Attachment({ data: Buffer.alloc(25 * MiB + 1), contentType: "audio/wav" }).sha256,
      ).toBeUndefined();
      await hueClient.withSpan("refused", () => {
        hueClient.recordFile({
          role: "input",
          mediaType: "audio/wav",
          path: file.path,
          upload: true,
        });
        hueClient.recordFile({
          role: "input",
          mediaType: "audio/wav",
          data: Buffer.alloc(25 * MiB + 1),
          upload: true,
        });
        hueClient.recordFile({
          role: "input",
          mediaType: "audio/wav",
          data: Buffer.alloc(1),
          path: file.path,
        });
      });
      await expect(hueClient.flush()).rejects.toThrow("Hue could not accept all telemetry");
      expect(hueClient.transport.getReport().instrumentationFailures).toBe(3);
      expect(endpoint.span("refused")!.events ?? []).toEqual([]);
      expect(endpoint.reservations).toEqual([]);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
      file.remove();
    }
  });

  test.skipIf(process.platform === "win32")(
    "a named pipe given by path is refused without waiting for a writer",
    async () => {
      const endpoint = hue();
      const hueClient = client(endpoint);
      const directory = mkdtempSync(join(tmpdir(), "hue-pipe-"));
      const pipe = join(directory, "recording.wav");
      execFileSync("mkfifo", [pipe]);
      // A writer for any open that waits, from 3 seconds on, so waiting fails this test rather than
      // hanging it.
      const writer = spawn("sh", ["-c", 'sleep 3; while :; do printf x > "$0"; done', pipe], {
        stdio: "ignore",
      });
      try {
        const started = performance.now();
        await hueClient.withSpan("piped", (span) => {
          span.setInput({ recording: new Attachment({ path: pipe, contentType: "audio/wav" }) });
          hueClient.recordFile({ role: "input", mediaType: "audio/wav", path: pipe, upload: true });
        });
        expect(performance.now() - started).toBeLessThan(1000);
        await expect(hueClient.flush()).rejects.toThrow("Hue could not accept all telemetry");
        expect(hueClient.transport.getReport().instrumentationFailures).toBe(2);
        const span = endpoint.span("piped")!;
        expect(JSON.parse(attr(span, "input.value")!.stringValue!)).toEqual({ recording: null });
        expect(span.events ?? []).toEqual([]);
        expect(endpoint.reservations).toEqual([]);
      } finally {
        writer.kill("SIGKILL");
        await hueClient.shutdown();
        endpoint.server.stop(true);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("uploads after export", () => {
  /** A GenAI message with an inline WAV part of `bytes`. */
  const audioMessage = (bytes: Buffer) =>
    JSON.stringify([
      {
        role: "user",
        parts: [
          { type: "text", content: "Transcribe this call." },
          {
            type: "blob",
            modality: "audio",
            mime_type: "audio/wav",
            content: bytes.toString("base64"),
          },
        ],
      },
    ]);

  test("a live parent stays deferred until a flush's file upload finishes", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint, { liveSpans: true });
    try {
      await hueClient.withSpan("live parent", async () => {
        await waitForMedia(() => hueClient.transport.getReport().pendingSpans === 1);
        await hueClient.withSpan("file span", (span) => {
          span.setInput({
            file: new Attachment({
              data: Buffer.from("synthetic file"),
              contentType: "text/plain",
            }),
          });
        });
        const flushed = hueClient.flushSafe({ timeoutMillis: 5000 });
        await waitForMedia(() => gate.entered === 1);
        await Bun.sleep(1700);
        expect(endpoint.decodedRequests.filter(({ signal }) => signal === "traces")).toHaveLength(
          1,
        );
        expect(hueClient.transport.getReport().pendingSpans).toBe(0);
        gate.release();
        expect(await flushed).toMatchObject({
          ok: true,
          timedOut: false,
          report: { acceptedSpans: 1, pendingSpans: 0, uploadedValues: 1 },
        });
      });
      expect(await hueClient.flush()).toMatchObject({ acceptedSpans: 2, pendingSpans: 0 });
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("the span is exported while its file's PUT is blocked, and flush waits for it", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint);
    const state = mediaState(hueClient);
    const audio = randomBytes(2 * MiB);
    const document = "d".repeat(2 * MiB);
    try {
      let traceId = "";
      await hueClient.withSpan("blocked upload", ({ span }) => {
        traceId = span.spanContext().traceId;
        span.setAttribute("gen_ai.input.messages", audioMessage(audio));
        span.setAttribute("custom.document", document);
      });
      let flushed = false;
      const flush = hueClient.flush().finally(() => {
        flushed = true;
      });
      await waitForMedia(
        () =>
          endpoint.span("blocked upload") !== undefined &&
          gate.entered === 2 &&
          hueClient.transport.getReport().pendingSpans === 0,
      );
      // On the wire while both PUTs are held: the audio as its digest, the document as its
      // prefix, both listed.
      const record = endpoint.span("blocked upload")!;
      const [message] = JSON.parse(attr(record, "gen_ai.input.messages")!.stringValue!) as {
        parts: Record<string, unknown>[];
      }[];
      expect(message!.parts[1]).toEqual({
        type: "blob",
        modality: "audio",
        mime_type: "audio/wav",
        sha256: sha256(audio),
        size: audio.byteLength,
      });
      expect(attr(record, "custom.document")!.stringValue).toBe("d".repeat(16 * KiB));
      expect(strings(attr(record, "hue.truncated"))).toEqual(["custom.document"]);
      expect(blobs(record)).toEqual([
        {
          key: "gen_ai.input.messages#/0/parts/1",
          sha256: sha256(audio),
          size: audio.byteLength,
          content_type: "audio/wav",
        },
        {
          key: "custom.document",
          sha256: sha256(document),
          size: document.length,
          content_type: "text/plain; charset=utf-8",
        },
      ]);
      expect(hueClient.transport.getReport().uploadedValues).toBe(0);
      expect(state.uploader.pendingBytes()).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(flushed).toBe(false);
      gate.release();
      const report = await flush;
      expect(report.uploadedValues).toBe(2);
      expect(report.uploadFallbacks).toBe(0);
      expect(endpoint.store.size).toBe(2);
      expect(endpoint.store.get(`${traceId}/${sha256(audio)}`)!.bytes.equals(audio)).toBe(true);
      expect(state.uploader.pendingBytes()).toBe(0);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a later span does not wait behind an earlier span's upload", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint);
    try {
      // Both spans are exported on the processor's timer, not by a flush.
      await hueClient.withSpan("uploading", ({ span }) => {
        span.setAttribute("custom.document", "u".repeat(2 * MiB));
      });
      await waitForMedia(() => endpoint.span("uploading") !== undefined && gate.entered === 1);
      await hueClient.withSpan("plain", ({ span }) => {
        span.setAttribute("custom.note", "short");
      });
      await waitForMedia(() => endpoint.span("plain") !== undefined);
      // The first span's PUT is still held.
      expect(endpoint.puts).toHaveLength(0);
      expect(hueClient.transport.getReport().uploadedValues).toBe(0);
      gate.release();
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(1);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a blob 429 never draws on the export's rate-limit hold or drops the span", async () => {
    // Both waits outlast the default 10 s request deadline.
    const endpoint = hue({
      reserve: () => ({ status: 429, headers: { "Retry-After": "59" } }),
      otlp: (index) =>
        index === 1 ? { status: 429, headers: { "Retry-After": "11" } } : undefined,
    });
    const hueClient = client(endpoint);
    try {
      await hueClient.withSpan("limited", ({ span }) => {
        span.setAttribute("custom.document", "l".repeat(2 * MiB));
      });
      // On the processor's timer: the upload waits 59 s to reserve again and the span is held
      // 11 s for its own request, neither waiting for the other. 0.18.2 charged both to one 60 s
      // hold and lost the span.
      const started = Date.now();
      await waitForMedia(() => hueClient.transport.getReport().acceptedSpans === 1, false, 25_000);
      expect(Date.now() - started).toBeLessThan(20_000);
      const report = hueClient.transport.getReport();
      expect(report.failedSpans).toBe(0);
      expect(report.droppedSpans).toBe(0);
      expect(blobs(endpoint.span("limited")!).map(({ key }) => key)).toEqual(["custom.document"]);
      expect(endpoint.reservations).toHaveLength(1);
      const outcome = await hueClient.shutdownSafe({ timeoutMillis: 200 });
      expect(outcome.timedOut).toBe(true);
      // The shutdown ended the upload's wait: counted as failed, its entry already sent.
      await waitForMedia(() => hueClient.transport.getReport().uploadFallbacks === 1);
      expect(hueClient.transport.getReport().uploadedValues).toBe(0);
      expect(endpoint.reservations).toHaveLength(1);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  }, 40_000);

  test("a reservation rate limit delays only the upload", async () => {
    let sentFirst = false;
    const endpoint = hue({
      reserve: (index) => {
        if (index === 2) sentFirst = endpoint.span("limited") !== undefined;
        return (index === 1 ? { status: 429, headers: { "Retry-After": "2" } } : undefined)!;
      },
    });
    const hueClient = client(endpoint);
    try {
      await hueClient.withSpan("limited", ({ span }) => {
        span.setAttribute("custom.document", "l".repeat(2 * MiB));
      });
      const started = Date.now();
      const report = await hueClient.flush();
      expect(sentFirst).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      expect(endpoint.reservations).toHaveLength(2);
      expect(report.uploadedValues).toBe(1);
      expect(report.uploadFallbacks).toBe(0);
      expect(report.failedSpans).toBe(0);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("an upload that fails after export keeps its entries at every entry point", async () => {
    const endpoint = hue({ reserve: () => ({ status: 403 }) });
    const hueClient = client(endpoint);
    const [image, metadata, file, attached] = [1, 2, 3, 4].map(() => randomBytes(4 * KiB)) as [
      Buffer,
      Buffer,
      Buffer,
      Buffer,
    ];
    const text = "t".repeat(2 * MiB);
    try {
      let traceId = "";
      await hueClient.withSpan("every entry point", (context) => {
        traceId = context.span.spanContext().traceId;
        context.span.setAttribute("gen_ai.input.messages", messageWithImage(image));
        context.span.setAttribute(
          "metadata",
          JSON.stringify({ image: `data:image/png;base64,${metadata.toString("base64")}` }),
        );
        context.span.setAttribute("custom.document", text);
        hueClient.recordFile({ role: "input", mediaType: "image/png", data: file, upload: true });
        context.setInput({
          report: new Attachment({ data: attached, contentType: "application/pdf" }),
        });
      });
      const report = await hueClient.flush();
      const record = endpoint.span("every entry point")!;
      expect(
        blobs(record)
          .map(({ key, sha256: digest }) => `${key} ${digest}`)
          .sort(),
      ).toEqual(
        [
          `gen_ai.input.messages#/0/parts/1 ${sha256(image)}`,
          `metadata#/image ${sha256(metadata)}`,
          `custom.document ${sha256(text)}`,
          `event:hue.file:${sha256(file)} ${sha256(file)}`,
          `input.value#/report ${sha256(attached)}`,
        ].sort(),
      );
      expect(attr(record, "custom.document")!.stringValue).toBe("t".repeat(16 * KiB));
      expect(endpoint.reservations).toHaveLength(5);
      expect(endpoint.store.size).toBe(0);
      expect(report.uploadedValues).toBe(0);
      expect(report.uploadFallbacks).toBe(5);
      const late = hueClient.transport
        .getIssues()
        .filter((issue) => issue.message === LATE_FALLBACK_MESSAGES.failed);
      expect(late).toHaveLength(1);
      expect(late[0]).toMatchObject({ kind: "warning", count: 5, traceIds: [traceId] });
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("bytes whose first upload failed are stored by a later reference in the trace", async () => {
    const endpoint = hue({ reserve: (index) => ({ status: index <= 3 ? 503 : 200 }) });
    const hueClient = client(endpoint);
    fastRetries(hueClient);
    const text = "r".repeat(2 * MiB);
    try {
      let traceId = "";
      await hueClient.withSpan("second reference", async ({ span }) => {
        traceId = span.spanContext().traceId;
        await hueClient.withSpan("first reference", (child) => {
          child.span.setAttribute("custom.document", text);
        });
        await hueClient.flush();
        // Three reservations, each refused for now: the first reference lists bytes Hue does not
        // store yet.
        expect(endpoint.reservations).toHaveLength(3);
        expect(endpoint.store.size).toBe(0);
        expect(hueClient.transport.getReport().uploadFallbacks).toBe(1);
        span.setAttribute("custom.document", text);
      });
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(1);
      expect(endpoint.reservations).toHaveLength(4);
      for (const name of ["first reference", "second reference"])
        expect(blobs(endpoint.span(name)!).map(({ key, sha256: digest }) => [key, digest])).toEqual(
          [["custom.document", sha256(text)]],
        );
      // Hue reads both entries by the trace and digest: the first resolves now too.
      expect(endpoint.store.get(`${traceId}/${sha256(text)}`)!.bytes.toString("utf8")).toBe(text);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("the span processor's forceFlush waits for uploads after the spans are sent (attach mode)", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const transport = createHueTransport({
      apiKey,
      serviceName: "attached-uploads",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    const hueClient = createHue({ transport, tracerProvider, loggerProvider });
    try {
      const span = tracerProvider.getTracer("application").startSpan("attached");
      span.setAttribute("custom.document", "a".repeat(2 * MiB));
      span.end();
      let flushed = false;
      const flush = tracerProvider.forceFlush({ timeoutMillis: 60_000 }).finally(() => {
        flushed = true;
      });
      await waitForMedia(() => endpoint.span("attached") !== undefined && gate.entered === 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(flushed).toBe(false);
      // A caller's budget ends its own wait; the upload goes on.
      const safe = await hueClient.flushSafe({ timeoutMillis: 200 });
      expect(safe.timedOut).toBe(true);
      expect((transport as unknown as { uploader: { closed: boolean } }).uploader.closed).toBe(
        false,
      );
      gate.release();
      await flush;
      expect(transport.getReport().uploadedValues).toBe(1);
      expect(blobs(endpoint.span("attached")!).map(({ key }) => key)).toEqual(["custom.document"]);
    } finally {
      gate.release();
      await hueClient.shutdown();
      await tracerProvider.shutdown();
      await loggerProvider.shutdown();
      await transport.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("reservation and PUT retry no reply, 408, 429 and 5xx three times, honouring Retry-After up to 60 s", async () => {
    const bytes = Buffer.from("retried payload");
    const digest = { sha256: sha256(bytes), size: bytes.byteLength };
    /** One store against a receiver behaving as `behavior`, with every wait recorded and skipped. */
    const attempt = async (behavior: Behavior) => {
      let puts = 0;
      const endpoint = hue({
        ...behavior,
        put: (index) => {
          puts = index;
          return behavior.put?.(index) ?? 200;
        },
      });
      const uploader = new BlobUploader({
        baseUrl: endpoint.url,
        apiKey,
        timeoutMillis: 200,
        allowInsecureHttp: false,
        userAgent: "blob-tests",
      });
      const waits: number[] = [];
      try {
        const outcome = await uploader.store(
          "1".repeat(32),
          `event:hue.file:${digest.sha256}`,
          bytes,
          "image/png",
          digest,
          {
            deadline: Date.now() + 10 * 60_000,
            wait: async (millis) => {
              waits.push(millis);
              return true;
            },
          },
        );
        return {
          outcome,
          reservations: endpoint.reservations.length,
          puts,
          waits,
          unsupported: uploader.unsupported(),
        };
      } finally {
        uploader.close();
        endpoint.server.stop(true);
      }
    };
    const statuses = (...list: number[]) => ({
      reserve: (index: number) => ({ status: list[index - 1] ?? 200 }),
    });
    // A reservation answered 408, 429 or a 5xx is tried again, a second and then two (with jitter)
    // later, three times in all.
    for (const status of [408, 429, 500, 503]) {
      const retried = await attempt(statuses(status, 200));
      expect(retried.outcome.ok).toBe(true);
      expect(retried.reservations).toBe(2);
      expect(retried.waits).toHaveLength(1);
      expect(retried.waits[0]).toBeGreaterThanOrEqual(1000);
      expect(retried.waits[0]).toBeLessThan(2000);
    }
    const exhausted = await attempt(statuses(503, 503, 503));
    expect(exhausted.outcome).toMatchObject({ ok: false, reason: "failed" });
    expect(exhausted.reservations).toBe(3);
    expect(exhausted.waits).toHaveLength(2);
    expect(exhausted.waits[1]).toBeGreaterThanOrEqual(2000);
    expect(exhausted.waits[1]).toBeLessThan(3000);
    // Retry-After is honoured, up to a minute.
    for (const [header, wait] of [
      ["7", 7000],
      ["120", 60_000],
    ] as const) {
      const limited = await attempt({
        reserve: (index) =>
          (index === 1 ? { status: 429, headers: { "Retry-After": header } } : undefined)!,
      });
      expect(limited.outcome.ok).toBe(true);
      expect(limited.waits).toEqual([wait]);
    }
    // A refusal of the key or the value is final; a receiver without the route is remembered.
    const refused = await attempt(statuses(401));
    expect(refused.outcome).toMatchObject({ ok: false, reason: "failed" });
    expect([refused.reservations, refused.waits.length, refused.unsupported]).toEqual([
      1,
      0,
      false,
    ]);
    const missing = await attempt({ reserve: () => ({ status: 404, json: false }) });
    expect(missing.outcome).toMatchObject({ ok: false, reason: "unsupported" });
    expect([missing.reservations, missing.waits.length, missing.unsupported]).toEqual([1, 0, true]);
    // A PUT that gets no answer, a 408, a 429 or a 5xx is tried again, three times in all.
    for (const answer of ["hang", 408, 429, 503] as const) {
      const retried = await attempt({ put: (index) => (index === 1 ? answer : 200) });
      expect(retried.outcome.ok).toBe(true);
      expect([retried.reservations, retried.puts, retried.waits.length]).toEqual([1, 2, 1]);
    }
    const twice = await attempt({ put: (index) => (index < 3 ? 503 : 200) });
    expect(twice.outcome.ok).toBe(true);
    expect([twice.puts, twice.waits.length]).toEqual([3, 2]);
    const failing = await attempt({ put: () => 503 });
    expect(failing.outcome).toMatchObject({ ok: false, reason: "failed" });
    expect([failing.reservations, failing.puts, failing.waits.length]).toEqual([1, 3, 2]);
    // A PUT's Retry-After is honoured as a reservation's is, up to a minute.
    for (const [header, wait] of [
      ["7", 7000],
      ["120", 60_000],
    ] as const) {
      const limited = await attempt({
        put: (index) => (index === 1 ? { status: 503, headers: { "Retry-After": header } } : 200),
      });
      expect(limited.outcome.ok).toBe(true);
      expect([limited.reservations, limited.puts, limited.waits]).toEqual([1, 2, [wait]]);
    }
    const rejected = await attempt({ put: () => 400 });
    expect(rejected.outcome).toMatchObject({ ok: false, reason: "failed" });
    expect([rejected.puts, rejected.waits.length]).toEqual([1, 0]);
  }, 20_000);

  test("close() ends a Retry-After wait at once", async () => {
    const endpoint = hue({ reserve: () => ({ status: 429, headers: { "Retry-After": "50" } }) });
    const uploader = new BlobUploader({
      baseUrl: endpoint.url,
      apiKey,
      timeoutMillis: 10_000,
      allowInsecureHttp: false,
      userAgent: "blob-tests",
    });
    const bytes = Buffer.from("waiting payload");
    try {
      const queued = uploader.enqueue(
        "1".repeat(32),
        `event:hue.file:${sha256(bytes)}`,
        bytes,
        "image/png",
        { sha256: sha256(bytes), size: bytes.byteLength },
      );
      if (!queued.ok) throw new Error("The upload was not queued");
      let settled = false;
      const done = queued.done.finally(() => {
        settled = true;
      });
      await waitForMedia(() => endpoint.reservations.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      expect(uploader.pendingBytes()).toBe(bytes.byteLength);
      const started = Date.now();
      uploader.close();
      expect(await done).toMatchObject({ ok: false, reason: "failed" });
      expect(Date.now() - started).toBeLessThan(100);
      expect(uploader.pendingBytes()).toBe(0);
      expect(endpoint.reservations).toHaveLength(1);
    } finally {
      uploader.close();
      endpoint.server.stop(true);
    }
  });

  test("files read in place from one recorded value charge it once, whole, until the last settles", async () => {
    // Each PUT waits to be let through, in the order the PUTs arrived.
    const waiting: (() => void)[] = [];
    const endpoint = hue({ beforePut: () => new Promise<void>((pass) => waiting.push(pass)) });
    const uploader = new BlobUploader({
      baseUrl: endpoint.url,
      apiKey,
      timeoutMillis: 10_000,
      allowInsecureHttp: false,
      userAgent: "blob-tests",
    });
    const value = JSON.stringify([
      {
        role: "user",
        parts: [
          { type: "text", content: "words ".repeat(1000) },
          { type: "blob", mime_type: "audio/wav", content: randomBytes(3000).toString("base64") },
          { type: "blob", mime_type: "audio/wav", content: randomBytes(3000).toString("base64") },
        ],
      },
    ]);
    const read = (await readLargeMediaText("gen_ai.input.messages", value, 300))!;
    expect(read.files).toHaveLength(2);
    try {
      const queued = [];
      for (const [index, file] of read.files.entries()) {
        const { source } = longFileBytes(file, read.long.get(file.content)!);
        const key = `gen_ai.input.messages#/0/parts/${index + 1}`;
        const digest = await digestOf(source);
        const result = uploader.enqueue("1".repeat(32), key, source, "audio/wav", digest);
        if (!result.ok) throw new Error("The upload was not queued");
        queued.push(result);
      }
      // Each slice keeps the whole string alive: the first upload charges all of it, once.
      expect(queued.map(({ bytes }) => bytes)).toEqual([value.length * 2, 0]);
      await waitForMedia(() => waiting.length === 2);
      expect(uploader.pendingBytes()).toBe(value.length * 2);
      let released = false;
      void queued[0]!.released.then(() => {
        released = true;
      });
      // One upload settles; the other still reads the string, which stays charged whole.
      waiting[0]!();
      expect((await Promise.race(queued.map(({ done }) => done))).ok).toBe(true);
      expect(uploader.pendingBytes()).toBe(value.length * 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(released).toBe(false);
      waiting[1]!();
      const outcomes = await Promise.all(queued.map(({ done }) => done));
      expect(outcomes.map(({ ok }) => ok)).toEqual([true, true]);
      expect(uploader.pendingBytes()).toBe(0);
      await queued[0]!.released;
      expect(endpoint.puts).toHaveLength(2);
    } finally {
      for (const pass of waiting) pass();
      uploader.close();
      endpoint.server.stop(true);
    }
  });

  test("a later file of a value already charged whole queues even when that value fills the budget", async () => {
    const waiting: (() => void)[] = [];
    const endpoint = hue({ beforePut: () => new Promise<void>((pass) => waiting.push(pass)) });
    const uploader = new BlobUploader({
      baseUrl: endpoint.url,
      apiKey,
      timeoutMillis: 10_000,
      allowInsecureHttp: false,
      userAgent: "blob-tests",
    });
    const value = JSON.stringify([
      {
        role: "user",
        parts: [
          { type: "blob", mime_type: "audio/wav", content: randomBytes(3000).toString("base64") },
          { type: "blob", mime_type: "audio/wav", content: randomBytes(3000).toString("base64") },
        ],
      },
    ]);
    const read = (await readLargeMediaText("gen_ai.input.messages", value, 300))!;
    const state = uploader as unknown as { queuedBytes: number };
    // Stands for a single value larger than the whole budget, admitted on its own.
    const oversize = MAX_HELD_BLOB_BYTES;
    try {
      const queued = [];
      for (const [index, file] of read.files.entries()) {
        const { source } = longFileBytes(file, read.long.get(file.content)!);
        const digest = await digestOf(source);
        const key = `gen_ai.input.messages#/0/parts/${index + 1}`;
        const result = uploader.enqueue("2".repeat(32), key, source, "audio/wav", digest);
        if (!result.ok) throw new Error(`File ${index + 1} was refused: ${result.reason}`);
        queued.push(result);
        if (index === 0) state.queuedBytes += oversize;
      }
      expect(queued.map(({ bytes }) => bytes)).toEqual([value.length * 2, 0]);
      state.queuedBytes -= oversize;
      await waitForMedia(() => waiting.length === 2);
      for (const pass of waiting) pass();
      expect((await Promise.all(queued.map(({ done }) => done))).map(({ ok }) => ok)).toEqual([
        true,
        true,
      ]);
      expect(uploader.pendingBytes()).toBe(0);
    } finally {
      for (const pass of waiting) pass();
      uploader.close();
      endpoint.server.stop(true);
    }
  });

  test("a queued upload past its lifetime is not tried and counts as failed", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint);
    const uploader = mediaState(hueClient).uploader;
    const files = Array.from({ length: 5 }, (_, index) => Buffer.from(`lifetime ${index}`));
    try {
      // Four uploads hold every place at the store for a second ...
      uploader.lifetimeMillis = 1000;
      await hueClient.withSpan("held", () => {
        for (const data of files.slice(0, 4))
          hueClient.recordFile({ role: "input", mediaType: "image/png", data, upload: true });
      });
      const started = Date.now();
      const flushed = hueClient.flush();
      await waitForMedia(() => gate.entered === 4);
      // ... while a fifth, whose lifetime ends long before any place frees, waits for one.
      uploader.lifetimeMillis = 100;
      await hueClient.withSpan("lifetime", () => {
        hueClient.recordFile({
          role: "input",
          mediaType: "image/png",
          data: files[4]!,
          upload: true,
        });
      });
      // Its own flush sends it at once, and its upload ends at its deadline without a request.
      const second = hueClient.flush();
      await flushed;
      const report = await second;
      expect(Date.now() - started).toBeLessThan(3000);
      expect(gate.entered).toBe(4);
      expect(endpoint.reservations.map((body) => body.sha256)).toEqual(
        files.slice(0, 4).map((data) => sha256(data)),
      );
      expect(report.uploadedValues).toBe(0);
      expect(report.uploadFallbacks).toBe(5);
      expect(blobs(endpoint.span("held")!).map(({ key }) => key)).toEqual(
        files.slice(0, 4).map((data) => `event:hue.file:${sha256(data)}`),
      );
      expect(blobs(endpoint.span("lifetime")!).map(({ key }) => key)).toEqual([
        `event:hue.file:${sha256(files[4]!)}`,
      ]);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("uploads awaiting completion share the 128 MiB budget and release it when they settle", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint);
    const state = mediaState(hueClient);
    // 35 Mi code units each: 70 MiB held, as a string is charged.
    const value = (fill: string) => fill.repeat(35 * MiB);
    try {
      await hueClient.withSpan("first", ({ span }) => {
        span.setAttribute("custom.document", value("a"));
      });
      await waitForMedia(
        () => endpoint.span("first") !== undefined && gate.entered === 1 && state.heldBytes === 0,
        false,
        10_000,
      );
      expect(state.uploader.pendingBytes()).toBe(70 * MiB);
      // The upload's bytes leave no room for a second value: it is cut when it is queued.
      await hueClient.withSpan("second", ({ span }) => {
        span.setAttribute("custom.document", value("b"));
      });
      await waitForMedia(() => endpoint.span("second") !== undefined, false, 10_000);
      const second = endpoint.span("second")!;
      expect(attr(second, "custom.document")!.stringValue).toBe("b".repeat(MiB));
      expect(attr(second, "hue.blobs")).toBeUndefined();
      expect(hueClient.transport.getReport().uploadFallbacks).toBe(1);
      expect(
        hueClient.transport.getIssues().map((issue) => [issue.message, issue.count]),
      ).toContainEqual([FALLBACK_MESSAGES.budget, 1]);
      gate.release();
      await hueClient.flush();
      expect(state.uploader.pendingBytes()).toBe(0);
      // Settled, the upload left room: a third value is held whole and uploaded.
      await hueClient.withSpan("third", ({ span }) => {
        span.setAttribute("custom.document", value("c"));
      });
      const report = await hueClient.flush();
      expect(blobs(endpoint.span("third")!).map(({ key }) => key)).toEqual(["custom.document"]);
      expect(report.uploadedValues).toBe(2);
      expect(report.uploadFallbacks).toBe(1);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  }, 30_000);

  test("hashing never waits behind uploads", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint);
    const text = "h".repeat(2 * MiB);
    try {
      await hueClient.withSpan("four uploads", () => {
        for (let index = 0; index < 4; index++)
          hueClient.recordFile({
            role: "input",
            mediaType: "image/png",
            data: Buffer.from(`held ${index}`),
            upload: true,
          });
      });
      await waitForMedia(() => gate.entered === 4);
      // Every upload place is taken: a new span's value is hashed, placed and sent all the same.
      await hueClient.withSpan("hashed", ({ span }) => {
        span.setAttribute("custom.document", text);
      });
      await waitForMedia(() => endpoint.span("hashed") !== undefined);
      const record = endpoint.span("hashed")!;
      expect(attr(record, "custom.document")!.stringValue).toBe("h".repeat(16 * KiB));
      expect(blobs(record)).toEqual([
        {
          key: "custom.document",
          sha256: sha256(text),
          size: text.length,
          content_type: "text/plain; charset=utf-8",
        },
      ]);
      // Its upload waits for a place.
      expect(endpoint.reservations).toHaveLength(4);
      gate.release();
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(5);
      expect(endpoint.reservations).toHaveLength(5);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("the upload queue refuses past 4,096 uploads with the fallback form", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const state = mediaState(hueClient);
    try {
      await hueClient.withSpan("queue full", ({ span }) => {
        span.setAttribute("custom.document", "q".repeat(2 * MiB));
      });
      state.uploader.queued = 4096;
      const report = await hueClient.flush();
      state.uploader.queued = 0;
      const record = endpoint.span("queue full")!;
      expect(attr(record, "custom.document")!.stringValue).toBe("q".repeat(MiB));
      expect(strings(attr(record, "hue.truncated"))).toEqual(["custom.document"]);
      expect(attr(record, "hue.blobs")).toBeUndefined();
      expect(endpoint.reservations).toEqual([]);
      expect(report.uploadFallbacks).toBe(1);
      expect(
        hueClient.transport.getIssues().find((issue) => issue.message === FALLBACK_MESSAGES.budget),
      ).toMatchObject({ kind: "warning", count: 1 });
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("an expired shutdownSafe ends queued and in-flight uploads; their entries stay and they are counted", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint);
    const state = mediaState(hueClient);
    const files = Array.from({ length: 6 }, (_, index) => Buffer.from(`shutdown ${index}`));
    try {
      await hueClient.withSpan("shut down", () => {
        for (const data of files)
          hueClient.recordFile({ role: "input", mediaType: "image/png", data, upload: true });
      });
      const outcome = await hueClient.shutdownSafe({ timeoutMillis: 500 });
      expect(outcome.timedOut).toBe(true);
      await hueClient.shutdown();
      // Four were in flight and two waited for a place: all six count as failed.
      expect(gate.entered).toBe(4);
      const report = hueClient.transport.getReport();
      expect(report.acceptedSpans).toBe(1);
      expect(report.uploadedValues).toBe(0);
      expect(report.uploadFallbacks).toBe(6);
      expect(blobs(endpoint.span("shut down")!)).toHaveLength(6);
      expect(state.uploader.closed).toBe(true);
      expect(state.uploader.pendingBytes()).toBe(0);
      expect(state.uploadReports.size).toBe(0);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a log record's body files are listed at once and upload in the background", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint);
    const png = randomBytes(2048);
    const pdf = Buffer.from("%PDF-1.4\n%background attachment\n%%EOF\n");
    try {
      await hueClient.withSpan("log files", () => {
        hueClient.recordMessages({
          input: [
            {
              role: "user",
              parts: [
                {
                  type: "blob",
                  modality: "image",
                  mime_type: "image/png",
                  content: png.toString("base64"),
                },
                new Attachment({ data: pdf, contentType: "application/pdf", name: "terms.pdf" }),
              ],
            },
          ],
          operation: "chat",
          provider: "openai",
        });
      });
      let flushed = false;
      const flush = hueClient.flush().finally(() => {
        flushed = true;
      });
      await waitForMedia(() => endpoint.logs().length === 1 && gate.entered === 2);
      const [log] = endpoint.logs();
      expect(blobs(log!).map(({ key, content_type }) => [key, content_type])).toEqual([
        ["body#/gen_ai.input.messages/0/parts/0", "image/png"],
        ["body#/gen_ai.input.messages/0/parts/1", "application/pdf"],
      ]);
      expect(flushed).toBe(false);
      expect(hueClient.transport.getReport().uploadedValues).toBe(0);
      gate.release();
      const report = await flush;
      expect(report.uploadedValues).toBe(2);
      expect(report.uploadFallbacks).toBe(0);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a later flush sends its own records without waiting for an earlier flush's uploads", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint);
    try {
      await hueClient.withSpan("request 1", ({ span }) => {
        span.setAttribute("custom.document", "1".repeat(2 * MiB));
      });
      const first = await hueClient.flushSafe({ timeoutMillis: 200 });
      expect(first.timedOut).toBe(true);
      await waitForMedia(() => endpoint.span("request 1") !== undefined && gate.entered === 1);
      // The first request's upload is held. The next request's flushSafe sends its own span
      // before it returns, rather than returning the first one's result.
      await hueClient.withSpan("request 2", ({ span }) => {
        span.setAttribute("custom.note", "short");
      });
      const second = await hueClient.flushSafe();
      expect(second).not.toBe(first);
      expect(second.timedOut).toBe(true);
      expect(endpoint.span("request 2")).toBeDefined();
      expect(second.report.acceptedSpans).toBe(2);
      // A strict flush sends its span at once too (the processor's own timer would take a
      // second), then waits for the held upload.
      await hueClient.withSpan("request 3", ({ span }) => {
        span.setAttribute("custom.note", "short");
      });
      const started = Date.now();
      let flushed = false;
      const flush = hueClient.flush().finally(() => {
        flushed = true;
      });
      await waitForMedia(() => endpoint.span("request 3") !== undefined);
      expect(Date.now() - started).toBeLessThan(900);
      expect(flushed).toBe(false);
      expect(endpoint.puts).toHaveLength(0);
      gate.release();
      const report = await flush;
      expect(report.acceptedSpans).toBe(3);
      expect(report.uploadedValues).toBe(1);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a receiver without the upload route is not asked again for ten minutes", async () => {
    const endpoint = hue({ reserve: () => ({ status: 404, json: false }) });
    const hueClient = client(endpoint);
    const text = "n".repeat(2 * MiB);
    const now = Date.now;
    const issues = (message: string) =>
      hueClient.transport
        .getIssues()
        .filter((issue) => issue.message === message)
        .map((issue) => issue.count);
    try {
      await hueClient.withSpan("first", ({ span }) => {
        span.setAttribute("custom.document", text);
      });
      await hueClient.flush();
      expect(blobs(endpoint.span("first")!).map(({ key }) => key)).toEqual(["custom.document"]);
      // Nine minutes on, the receiver is still taken to lack the route: the value keeps its
      // inline fallback, never another entry the receiver cannot resolve.
      Date.now = () => now() + 9 * 60_000;
      await hueClient.withSpan("nine minutes later", ({ span }) => {
        span.setAttribute("custom.document", text);
      });
      await hueClient.flush();
      const cut = endpoint.span("nine minutes later")!;
      expect(attr(cut, "custom.document")!.stringValue).toBe("n".repeat(MiB));
      expect(strings(attr(cut, "hue.truncated"))).toEqual(["custom.document"]);
      expect(attr(cut, "hue.blobs")).toBeUndefined();
      expect(endpoint.reservations).toHaveLength(1);
      expect(issues(FALLBACK_MESSAGES.unsupported)).toEqual([1]);
      // Past ten minutes it is asked again, so a misread answer never turns uploads off for good.
      Date.now = () => now() + 11 * 60_000;
      await hueClient.withSpan("eleven minutes later", ({ span }) => {
        span.setAttribute("custom.document", text);
      });
      await hueClient.flush();
      expect(blobs(endpoint.span("eleven minutes later")!).map(({ key }) => key)).toEqual([
        "custom.document",
      ]);
      expect(endpoint.reservations).toHaveLength(2);
      expect(issues(LATE_FALLBACK_MESSAGES.unsupported)).toEqual([1, 1]);
    } finally {
      Date.now = now;
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("a value counts once against the 128 MiB budget while its record's export is still held", async () => {
    const gate = putGate();
    const endpoint = hue({
      beforePut: gate.beforePut,
      otlp: (index) => (index === 1 ? { status: 429, headers: { "Retry-After": "4" } } : undefined),
    });
    const hueClient = client(endpoint);
    const state = mediaState(hueClient);
    try {
      // 35 Mi code units: 70 MiB, charged to the queued record and, once queued, to its upload.
      await hueClient.withSpan("first", ({ span }) => {
        span.setAttribute("custom.document", "a".repeat(35 * MiB));
      });
      // Its upload is in flight while the receiver holds its export off.
      await waitForMedia(() => gate.entered === 1, false, 10_000);
      expect(hueClient.transport.getReport().pendingSpans).toBe(1);
      expect(state.heldBytes).toBe(0);
      expect(state.uploader.pendingBytes()).toBe(70 * MiB);
      // 40 MiB more fits the budget: the second value is held whole, not cut.
      await hueClient.withSpan("second", ({ span }) => {
        span.setAttribute("custom.document", "b".repeat(20 * MiB));
      });
      expect(state.heldBytes).toBe(40 * MiB);
      gate.release();
      const report = await hueClient.flush();
      const second = endpoint.span("second")!;
      expect(attr(second, "custom.document")!.stringValue).toBe("b".repeat(16 * KiB));
      expect(blobs(second).map(({ key }) => key)).toEqual(["custom.document"]);
      expect(report.uploadedValues).toBe(2);
      expect(report.uploadFallbacks).toBe(0);
      expect(state.heldBytes).toBe(0);
      expect(state.uploader.pendingBytes()).toBe(0);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  }, 30_000);

  test("an attached provider's forceFlush waits for an upload queued by an export still being sent", async () => {
    const gate = putGate();
    const endpoint = hue({
      beforePut: gate.beforePut,
      otlp: (index) => (index === 1 ? { status: 429, headers: { "Retry-After": "3" } } : undefined),
    });
    const transport = createHueTransport({
      apiKey,
      serviceName: "attached-timer-export",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    try {
      const span = tracerProvider.getTracer("application").startSpan("attached");
      span.setAttribute("custom.document", "a".repeat(2 * MiB));
      span.end();
      // The processor's timer export queued the upload and is held by the receiver's 429.
      await waitForMedia(() => gate.entered === 1, false, 5000);
      expect(transport.getReport().pendingSpans).toBe(1);
      let flushed = false;
      const flush = tracerProvider.forceFlush({ timeoutMillis: 60_000 }).finally(() => {
        flushed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(flushed).toBe(false);
      gate.release();
      await flush;
      expect(endpoint.store.size).toBe(1);
    } finally {
      gate.release();
      await tracerProvider.shutdown();
      await transport.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("an offload step that throws counts its values once", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const uploader = mediaState(hueClient).uploader as unknown as {
      enqueue(...args: unknown[]): unknown;
    };
    const enqueue = uploader.enqueue.bind(uploader);
    let calls = 0;
    // The second value's placement throws once the first value's upload is queued: the record is
    // placed by the fallback, and the uploads it queued run on, uncounted.
    uploader.enqueue = (...args) => {
      const queued = enqueue(...args);
      if (++calls === 2) throw new Error("synthetic placement failure");
      return queued;
    };
    try {
      await hueClient.withSpan("thrown", ({ span }) => {
        span.setAttribute("custom.first", "1".repeat(2 * MiB));
        span.setAttribute("custom.second", "2".repeat(3 * MiB));
      });
      const report = await hueClient.flush();
      const record = endpoint.span("thrown")!;
      expect(attr(record, "custom.first")!.stringValue).toBe("1".repeat(MiB));
      expect(attr(record, "custom.second")!.stringValue).toBe("2".repeat(MiB));
      expect(attr(record, "hue.blobs")).toBeUndefined();
      expect(report.uploadedValues).toBe(0);
      expect(report.uploadFallbacks).toBe(2);
      await waitForMedia(() => endpoint.completions.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(hueClient.transport.getReport().uploadedValues).toBe(0);
      expect(hueClient.transport.getReport().uploadFallbacks).toBe(2);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("an upload waiting out a Retry-After leaves its place to the uploads behind it", async () => {
    // The first four reservations are rate limited for a second: the fifth upload is reserved and
    // stored while they wait, not a second later.
    const endpoint = hue({
      reserve: (index) =>
        (index <= 4 ? { status: 429, headers: { "Retry-After": "1" } } : undefined)!,
    });
    const uploader = new BlobUploader({
      baseUrl: endpoint.url,
      apiKey,
      timeoutMillis: 10_000,
      allowInsecureHttp: false,
      userAgent: "blob-tests",
    });
    const files = Array.from({ length: 5 }, (_, index) => Buffer.from(`waiting ${index}`));
    try {
      const started = Date.now();
      const done = files.map((bytes) => {
        const queued = uploader.enqueue(
          "1".repeat(32),
          `event:hue.file:${sha256(bytes)}`,
          bytes,
          "image/png",
          { sha256: sha256(bytes), size: bytes.byteLength },
        );
        if (!queued.ok) throw new Error("The upload was not queued");
        return queued.done;
      });
      await waitForMedia(() => endpoint.store.size >= 1);
      expect(Date.now() - started).toBeLessThan(900);
      expect(endpoint.store.size).toBe(1);
      expect(endpoint.reservations).toHaveLength(5);
      const outcomes = await Promise.all(done);
      expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, true, true, true]);
      expect(endpoint.reservations).toHaveLength(9);
      expect(endpoint.store.size).toBe(5);
    } finally {
      uploader.close();
      endpoint.server.stop(true);
    }
  });

  test("an upload whose place is taken while it waits out a Retry-After still ends at its deadline", async () => {
    // The first upload's reservation is refused for a second. Four uploads queued meanwhile take
    // every place and hold their PUTs until their own deadlines, half a second after its own.
    const gate = putGate();
    const endpoint = hue({
      beforePut: gate.beforePut,
      reserve: (index) =>
        (index === 1 ? { status: 503, headers: { "Retry-After": "1" } } : undefined)!,
    });
    const uploader = new BlobUploader({
      baseUrl: endpoint.url,
      apiKey,
      timeoutMillis: 60_000,
      allowInsecureHttp: false,
      userAgent: "blob-tests",
    });
    (uploader as unknown as { lifetimeMillis: number }).lifetimeMillis = 2000;
    const enqueue = (bytes: Buffer) => {
      const queued = uploader.enqueue(
        "1".repeat(32),
        `event:hue.file:${sha256(bytes)}`,
        bytes,
        "image/png",
        { sha256: sha256(bytes), size: bytes.byteLength },
      );
      if (!queued.ok) throw new Error("The upload was not queued");
      return queued.done;
    };
    try {
      const started = Date.now();
      const first = enqueue(Buffer.from("rate limited"));
      await waitForMedia(() => endpoint.reservations.length === 1);
      await new Promise((resolve) => setTimeout(resolve, started + 500 - Date.now()));
      let settled = 0;
      for (let index = 0; index < 4; index++)
        void enqueue(Buffer.from(`holding ${index}`)).finally(() => settled++);
      await waitForMedia(() => gate.entered === 4);
      expect(await first).toMatchObject({ ok: false, reason: "failed" });
      // It stopped waiting for a place at its deadline, not when a place came free.
      expect(settled).toBe(0);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(endpoint.reservations).toHaveLength(5);
    } finally {
      uploader.close();
      gate.release();
      endpoint.server.stop(true);
    }
  });

  for (const signal of ["traces", "logs"] as const)
    test(`a pending upload keeps alive its own bytes, never its finished record (${signal})`, async () => {
      const gate = putGate();
      const endpoint = hue({ beforePut: gate.beforePut });
      const hueClient = client(endpoint);
      const pending = (
        mediaState(hueClient) as unknown as Record<"spans" | "logs", Map<object, number>>
      )[signal === "traces" ? "spans" : "logs"];
      const image = randomBytes(100 * KiB);
      try {
        await hueClient.withSpan("retained", ({ span }) => {
          if (signal === "logs")
            hueClient.recordMessages({
              input: [
                {
                  role: "user",
                  parts: [
                    {
                      type: "blob",
                      modality: "image",
                      mime_type: "image/png",
                      content: image.toString("base64"),
                    },
                  ],
                },
              ],
              operation: "chat",
              provider: "openai",
            });
          else span.setAttribute("gen_ai.input.messages", messageWithImage(image));
          span.setAttribute("custom.note", "n".repeat(256 * KiB));
        });
        const record = new WeakRef(pending.keys().next().value!);
        const flush = hueClient.flush();
        await waitForMedia(() => {
          const report = hueClient.transport.getReport();
          return (
            gate.entered >= 1 &&
            report.pendingSpans === 0 &&
            report.pendingLogs === 0 &&
            report.acceptedSpans === 1
          );
        });
        // Exported and finished while its image's PUT is held: the upload holds the image alone.
        await waitForMedia(() => record.deref() === undefined, true);
        expect(mediaState(hueClient).uploader.pendingBytes()).toBeGreaterThanOrEqual(100 * KiB);
        gate.release();
        expect((await flush).uploadedValues).toBeGreaterThanOrEqual(1);
      } finally {
        gate.release();
        await hueClient.shutdown();
        endpoint.server.stop(true);
      }
    });

  test("a value stays charged to its record when its upload settles before the record's export", async () => {
    // Hue already stores the value, and holds the record's export off with a rate limit.
    const endpoint = hue({
      reserve: () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "exists",
          ref: { content_type: "text/plain; charset=utf-8" },
        }),
      }),
      otlp: (index) => (index === 1 ? { status: 429, headers: { "Retry-After": "3" } } : undefined),
    });
    const hueClient = client(endpoint);
    const state = mediaState(hueClient);
    try {
      // 2 Mi code units: 4 MiB, charged while the queued record holds the value whole.
      await hueClient.withSpan("settled first", ({ span }) => {
        span.setAttribute("custom.document", "e".repeat(2 * MiB));
      });
      expect(state.heldBytes).toBe(4 * MiB);
      await waitForMedia(
        () =>
          endpoint.reservations.length === 1 &&
          state.uploader.pendingBytes() === 0 &&
          state.uploadReports.size === 0,
      );
      expect(hueClient.transport.getReport().pendingSpans).toBe(1);
      expect(state.heldBytes).toBe(4 * MiB);
      const report = await hueClient.flush();
      expect(report.uploadedValues).toBe(1);
      expect(blobs(endpoint.span("settled first")!).map(({ key }) => key)).toEqual([
        "custom.document",
      ]);
      expect(state.heldBytes).toBe(0);
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  }, 15_000);

  test("flushes while thousands of uploads are pending each cost the same small amount", async () => {
    const gate = putGate();
    const endpoint = hue({ beforePut: gate.beforePut });
    const hueClient = client(endpoint);
    const state = mediaState(hueClient);
    try {
      // 64 spans of 63 files each: 4,032 uploads queued, four held at their PUT and the rest waiting.
      for (let index = 0; index < 64; index++)
        await hueClient.withSpan(`pending ${index}`, () => {
          for (let file = 0; file < 63; file++)
            hueClient.recordFile({
              role: "input",
              mediaType: "image/png",
              data: Buffer.from(`pending ${index} ${file}`),
              upload: true,
            });
        });
      const first = hueClient.flush().catch(() => undefined);
      await waitForMedia(
        () =>
          state.uploader.queued === 4032 && hueClient.transport.getReport().acceptedSpans === 64,
      );
      Bun.gc(true);
      const before = process.memoryUsage().heapUsed;
      for (let call = 0; call < 1000; call++)
        expect((await hueClient.flushSafe({ timeoutMillis: 1 })).timedOut).toBe(true);
      Bun.gc(true);
      const grown = process.memoryUsage().heapUsed - before;
      // Each flush waits on one promise for all the uploads queued before it, never on each one:
      // a thousand flushes once kept ~150 MiB of waits on the 4,032 pending uploads alive.
      expect(grown).toBeLessThan(32 * MiB);
      expect(state.uploader.queued).toBe(4032);
      expect((await hueClient.shutdownSafe({ timeoutMillis: 200 })).timedOut).toBe(true);
      await hueClient.shutdown();
      await first;
      expect(hueClient.transport.getReport().uploadFallbacks).toBe(4032);
    } finally {
      gate.release();
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  }, 30_000);
});
