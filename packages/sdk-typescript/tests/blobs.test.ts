import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ROOT_CONTEXT, trace, type Span } from "@opentelemetry/api";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import protobuf from "protobufjs/light.js";
import {
  createHue,
  createHueTransport,
  type ExportIssue,
  type HueTransport,
} from "../src/index.js";
import { fallbackAttributes, newTally } from "../src/blobs.js";
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
  /** The store's status for a PUT; 200 stores the bytes. */
  put?: (index: number) => number | "hang" | "expired";
  beforePut?: () => Promise<void>;
  complete?: (index: number) => number;
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
        const status = behavior.put?.(++putCount) ?? 200;
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
          return new Response("<Error><Code>InternalError</Code></Error>", { status });
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
        if (store.has(objectKey)) return Response.json({ status: "exists", ref });
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
      expect(
        hueClient.transport
          .getIssues()
          .some((issue) => issue.message.startsWith("Content could not be uploaded")),
      ).toBe(true);
      // The refusal paused uploads, so the next value meets no request; it is not taken for a
      // receiver without the route, whose values are cut when queued.
      await hueClient.withSpan("again", (context) => {
        context.span.setAttribute("custom.document", "a".repeat(2 * MiB));
      });
      await hueClient.flush();
      expect(endpoint.reservations).toHaveLength(1);
      expect(attr(endpoint.span("again")!, "custom.document")!.stringValue).toBe("a".repeat(MiB));
      expect(
        hueClient.transport
          .getIssues()
          .filter((issue) => issue.message.startsWith("Content could not be uploaded")),
      ).toHaveLength(2);
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
          expect(attr(endpoint.span(span)!, "custom.document")!.stringValue).toBe("r".repeat(MiB));
        }
        expect(endpoint.reservations).toHaveLength(1);
        expect(endpoint.puts).toHaveLength(0);
        const warnings = hueClient.transport
          .getIssues()
          .filter((issue) => issue.message.startsWith("This Hue server does not accept uploaded"));
        expect(warnings.map((issue) => issue.count)).toEqual([1, 1]);
      } finally {
        await hueClient.shutdown();
        endpoint.server.stop(true);
      }
    });

  test("a value that cannot be uploaded is exported cut as before, reported and counted, and uploads pause", async () => {
    const endpoint = hue({ put: () => 503 });
    const issues: ExportIssue[] = [];
    const hueClient = client(endpoint, {
      onExportIssue: (issue: ExportIssue) => {
        issues.push(issue);
      },
    });
    const text = "f".repeat(2 * MiB);
    const image = randomBytes(100 * KiB);
    try {
      let traceId = "";
      await hueClient.withSpan("fallback", (context) => {
        traceId = context.span.spanContext().traceId;
        context.span.setAttribute("custom.document", text);
        context.span.setAttribute("gen_ai.input.messages", messageWithImage(image));
      });
      // The export succeeds: every record was delivered, with the values cut.
      const report = await hueClient.flush();
      expect(report.acceptedSpans).toBe(1);
      expect(report.uploadedValues).toBe(0);
      expect(report.uploadFallbacks).toBe(2);
      const record = endpoint.span("fallback")!;
      expect(attr(record, "custom.document")!.stringValue).toBe("f".repeat(MiB));
      expect(strings(attr(record, "hue.truncated"))).toEqual(["custom.document"]);
      expect(attr(record, "hue.blobs")).toBeUndefined();
      // The image falls back to its digest, as the SDK exported it before uploads.
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
      expect(warning).toMatchObject({ kind: "warning", count: 2, traceIds: [traceId] });
      expect(issues.some((issue) => issue.message === warning.message)).toBe(true);
      // Each failed PUT was retried once, never more; the failure paused uploads, so a later
      // value meets no request at all.
      const attempts = endpoint.puts.length;
      expect(attempts).toBe(4);
      await hueClient.withSpan("paused", (context) => {
        context.span.setAttribute("custom.document", text);
      });
      await hueClient.flush();
      expect(endpoint.puts.length).toBe(attempts);
      expect(attr(endpoint.span("paused")!, "custom.document")!.stringValue).toBe("f".repeat(MiB));
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
        expect(attr(endpoint.span(name)!, "custom.document")!.stringValue).toBe("n".repeat(MiB));
      }
      expect(endpoint.reservations).toHaveLength(1);
      const warnings = hueClient.transport
        .getIssues()
        .filter((issue) => issue.message.startsWith("This Hue server does not accept uploaded"));
      expect(warnings.map((issue) => issue.count)).toEqual([1, 1]);
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
    const endpoint = hue({
      reserve: (index) =>
        (index === 1 ? { status: 429, headers: { "Retry-After": "1" } } : undefined)!,
    });
    const hueClient = client(endpoint);
    try {
      await hueClient.withSpan("limited", (context) => {
        context.span.setAttribute("custom.document", "l".repeat(2 * MiB));
      });
      const started = Date.now();
      await hueClient.flush();
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(endpoint.reservations).toHaveLength(2);
      expect(blobs(endpoint.span("limited")!)).toHaveLength(1);
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

  test("a store that never answers delays the export by the upload budget at most", async () => {
    const endpoint = hue({ put: () => "hang" });
    const hueClient = client(endpoint, { timeoutMillis: 200 });
    try {
      await hueClient.withSpan("hung", (context) => {
        context.span.setAttribute("custom.document", "h".repeat(2 * MiB));
      });
      const started = Date.now();
      const report = await hueClient.flush();
      // Six request budgets for the uploads, then the span's own request.
      expect(Date.now() - started).toBeLessThan(5000);
      expect(report.uploadFallbacks).toBe(1);
      expect(attr(endpoint.span("hung")!, "custom.document")!.stringValue).toBe("h".repeat(MiB));
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

for (const item of fixtures) {
  for (const mode of ["success", "failure"] as const) {
    test(`media wire ${mode}: ${item.id}`, async () => {
      const endpoint = hue(mode === "failure" ? { reserve: () => ({ status: 403 }) } : {});
      const hueClient = client(endpoint);
      try {
        await hueClient.withSpan(item.id, ({ span }) => {
          span.setAttribute(item.attribute, item.value ?? JSON.stringify(item.messages));
        });
        const report = await hueClient.flush();
        expect(report.acceptedSpans).toBe(1);
        const record = endpoint.span(item.id)!;
        const exported = attr(record, item.attribute)!.stringValue!;
        if (item.value === undefined) expect(JSON.parse(exported)).toEqual(item[mode].messages);
        else expect(exported).toBe(item[mode].value!);
        expect(strings(attr(record, "hue.blobs")) ?? []).toEqual(item[mode].entries);
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

test("failed media reservations pause inline and explicit occurrences without caching failures", async () => {
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
    expect(endpoint.reservations).toHaveLength(1);
    expect(endpoint.puts).toHaveLength(0);
    expect(blobs(endpoint.span("failed parent")!)).toEqual([]);
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
    uploader: {
      unsupportedUntil: number;
      pausedUntil: number;
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

async function waitForMedia(predicate: () => boolean, collect = false) {
  const deadline = Date.now() + 3000;
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

test("ordinary shutdown waits for in-flight media acknowledgement before closing the uploader", async () => {
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
    expect(settled).toBe(false);
    expect(state.uploader.closed).toBe(false);
    expect(state.media.size).toBe(1);
    expect(state.mediaOwners.size).toBe(0);
    expect(state.heldBytes).toBe(bytes.byteLength);
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

test("failed uploads and pause refusals retry after the transient pause", async () => {
  const endpoint = hue({ reserve: (index) => ({ status: index === 1 ? 503 : 200 }) });
  const hueClient = client(endpoint);
  const bytes = Buffer.from("retry this media");
  try {
    expect((await storeMedia(hueClient, bytes)).ok).toBe(false);
    const state = mediaState(hueClient);
    expect(state.uploader.pausedUntil).toBeGreaterThan(Date.now());
    expect(state.uploader.outcomes.size).toBe(0);
    expect((await storeMedia(hueClient, bytes)).ok).toBe(false);
    expect((await storeMedia(hueClient, Buffer.from("other media during pause"))).ok).toBe(false);
    expect(endpoint.reservations).toHaveLength(1);
    expect(state.uploader.outcomes.size).toBe(0);
    state.uploader.pausedUntil = 0;
    expect((await storeMedia(hueClient, bytes)).ok).toBe(true);
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
      expect(state.uploader.pausedUntil).toBe(0);
      expect((await storeMedia(hueClient, Buffer.from("next valid payload"))).ok).toBe(true);
      expect(endpoint.reservations).toHaveLength(2);
      expect(endpoint.completions.at(-1)?.sha256).toBe(sha256("next valid payload"));
    } finally {
      await hueClient.shutdown();
      endpoint.server.stop(true);
    }
  }
});

test("transient PUT and completion statuses pause further uploads", async () => {
  for (const path of ["put", "complete"] as const) {
    for (const status of [429, 503]) {
      const endpoint = hue(path === "put" ? { put: () => status } : { complete: () => status });
      const hueClient = client(endpoint);
      try {
        await storeMedia(hueClient, Buffer.from("transient first payload"));
        expect(mediaState(hueClient).uploader.pausedUntil).toBeGreaterThan(Date.now());
        expect((await storeMedia(hueClient, Buffer.from("paused next payload"))).ok).toBe(false);
        expect(endpoint.reservations).toHaveLength(1);
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

test("a longer existing-object MIME is checked again before final helper delivery", async () => {
  const bytes = Buffer.from("existing object media");
  const calibration = hue();
  const calibrated = attachedMediaClient(calibration, false);
  let decodedBytes: number;
  try {
    await calibrated.hueClient.withSpan("final helper MIME fitting", () => {
      calibrated.hueClient.recordFile({
        role: "output",
        mediaType: "image/png",
        name: "fitting.png",
        data: bytes,
        upload: true,
      });
    });
    await calibrated.hueClient.flush();
    expect(calibration.span("final helper MIME fitting")).toBeDefined();
    decodedBytes = calibration.decodedRequests.find(
      (request) => request.signal === "traces",
    )!.bytes;
  } finally {
    await calibrated.shutdown();
    calibration.server.stop(true);
  }
  const contentType = `application/${"x".repeat(243)}`;
  const endpoint = hue({
    reserve: () => ({
      status: 200,
      body: JSON.stringify({
        status: "exists",
        ref: {
          key: `event:hue.file:${sha256(bytes)}`,
          sha256: sha256(bytes),
          size: bytes.length,
          content_type: contentType,
        },
      }),
    }),
  });
  const attached = attachedMediaClient(endpoint, false);
  setDecodedLimit(attached.hueClient, decodedBytes + 64);
  try {
    await attached.hueClient.withSpan("final helper MIME fitting", () => {
      attached.hueClient.recordFile({
        role: "output",
        mediaType: "image/png",
        name: "fitting.png",
        data: bytes,
        upload: true,
      });
    });
    await expect(attached.hueClient.flush()).rejects.toThrow("Hue could not accept all telemetry");
    const report = attached.hueClient.transport.getReport();
    expect(endpoint.reservations).toHaveLength(1);
    expect(endpoint.puts).toHaveLength(0);
    expect(endpoint.span("final helper MIME fitting")).toBeUndefined();
    expect(report.uploadedValues).toBe(1);
    expect(report.uploadFallbacks).toBe(0);
    expect(report.failedSpans).toBe(1);
  } finally {
    await attached.shutdown();
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
  for (const mode of ["success", "failure"] as const) {
    test(`log media wire ${mode}: ${item.id}`, async () => {
      const endpoint = hue(mode === "failure" ? { reserve: () => ({ status: 403 }) } : {});
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
        const report = await hueClient.flush();
        const [log] = endpoint.logs();
        expect(hex(log!.traceId)).toBe(traceId);
        expect(jsonOf(log!.body)).toEqual(item[mode].body);
        expect(strings(attr(log!, "hue.blobs")) ?? []).toEqual(item[mode].entries);
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
        } else expect(report.uploadFallbacks).toBe(item.success.entries.length);
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

  test("a value past the per-attribute inspection limit is not walked for media", async () => {
    const endpoint = hue();
    const hueClient = client(endpoint);
    const large = Buffer.alloc(6 * MiB + 1, 7);
    try {
      await hueClient.withSpan("over inspection", ({ span }) => {
        span.setAttribute("input.value", JSON.stringify({ image: dataUrl(large) }));
      });
      await hueClient.flush();
      const record = endpoint.span("over inspection")!;
      // Over 8 MiB of text: uploaded whole as before, its image never parsed out of it.
      expect(blobs(record).map(({ key, content_type }) => [key, content_type])).toEqual([
        ["input.value", "application/json"],
      ]);
      expect(
        attr(record, "hue.truncated")!.arrayValue!.values.map((item) => item.stringValue),
      ).toEqual(["input.value"]);
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
