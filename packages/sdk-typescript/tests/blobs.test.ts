import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { createHue, type ExportIssue } from "../src/index.js";
import { fallbackAttributes, newTally } from "../src/blobs.js";
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
type WireRecord = { traceId: string; name?: string; attributes?: Attribute[]; body?: Value };

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
        if (!store.has(`${String(body.traceId)}/${String(body.sha256)}`))
          return Response.json({ error: "Not uploaded.", status: "missing" }, { status: 409 });
        return Response.json({ status: "complete" });
      }
      const signal = url.pathname.endsWith("/logs") ? "logs" : "traces";
      const namespace = `opentelemetry.proto.collector.${signal === "traces" ? "trace" : "logs"}.v1.Export${signal === "traces" ? "Trace" : "Logs"}Service`;
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      const type = root.lookupType(`${namespace}Request`);
      const data = type.toObject(type.decode(bytes), { longs: String, bytes: String });
      const decoded: WireRecord[] =
        signal === "traces"
          ? data.resourceSpans.flatMap((group: { scopeSpans: { spans: WireRecord[] }[] }) =>
              group.scopeSpans.flatMap((scope) => scope.spans),
            )
          : data.resourceLogs.flatMap((group: { scopeLogs: { logRecords: WireRecord[] }[] }) =>
              group.scopeLogs.flatMap((scope) => scope.logRecords),
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
      JSON.parse(entry) as { key: string; sha256: string; size: number; content_type: string },
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
          key: "gen_ai.input.messages#/0/parts/1/content",
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
      // The image part keeps its other fields and the first 16 KiB of its inline content; the
      // message, now small, is exported whole.
      const [message] = JSON.parse(attr(record, "gen_ai.input.messages")!.stringValue!) as {
        parts: Record<string, unknown>[];
      }[];
      expect(message!.parts[0]).toEqual({ type: "text", content: "Describe this image." });
      expect(message!.parts[1]).toEqual({
        type: "blob",
        modality: "image",
        mime_type: "image/png",
        content: image.toString("base64").slice(0, 16 * KiB),
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
      // The parent's value, the same value in the same trace, is answered `exists`.
      expect(endpoint.puts).toHaveLength(1);
      expect(endpoint.reservations).toHaveLength(2);
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

  test("two spans uploading one value at once: the PUT that loses the race is answered 412 and taken as stored", async () => {
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
      expect(endpoint.puts.map((put) => put.status).sort()).toEqual([200, 412]);
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
      expect(hueClient.transport.getIssues().map((issue) => issue.message.slice(0, 40))).toContain(
        "Values over Hue's inline limit could not",
      );
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
          .filter((issue) => issue.message.startsWith("Values over Hue's inline limit could not")),
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
        { key: "gen_ai.input.messages#/0/parts/1/content", sha256: sha256(image) },
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
