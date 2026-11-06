/**
 * A non-loopback Hue origin must not be able to choose where output bytes are PUT.
 * These tests fail while the worker still delivers the file. They pass once it does not.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { BlobUploader } from "../src/blobs.js";
import { HueApiError, createEvaluationClient } from "../src/evals/client.js";
import { createManagedTargetHandler, type ManagedInvocation } from "../src/managed.js";

const require = createRequire(import.meta.url);
const dns = require("node:dns") as typeof import("node:dns");
const executionId = "11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";
const traceId = "1234567890abcdef1234567890abcdef";
const output = Buffer.from("synthetic model output");
const apiHost = "hue-api.invalid";
const rebindingHost = "storage.invalid";
const publicAddress = "203.0.113.10";
const certDir = mkdtempSync(join(tmpdir(), "hue-upload-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    join(certDir, "key.pem"),
    "-out",
    join(certDir, "cert.pem"),
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=sink.invalid",
  ],
  { stdio: "pipe" },
);
const tlsMaterial = {
  key: readFileSync(join(certDir, "key.pem")),
  cert: readFileSync(join(certDir, "cert.pem")),
};

type Hit = { method: string; url: string; body: Buffer };
type Sink = { port: number; hits: Hit[]; close: () => Promise<void> };

const savedLookup = dns.lookup;
const savedResolve4 = dns.resolve4;
const originalLookup = savedLookup as (
  hostname: string,
  options: unknown,
  callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
) => unknown;
const originalResolve4 = savedResolve4 as (
  hostname: string,
  options: unknown,
  callback: (error: NodeJS.ErrnoException | null, addresses: string[]) => void,
) => unknown;
const originalPromiseLookup = dns.promises.lookup.bind(dns.promises);
const originalPromiseResolve4 = dns.promises.resolve4.bind(dns.promises);
const originalConnect = Socket.prototype.connect;
const connectAddress = new Map<string, string>([
  [apiHost, "127.0.0.1"],
  [rebindingHost, "127.0.0.1"],
  ["localhost", "127.0.0.1"],
]);

function localAddress(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized.startsWith("127.") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("::ffff:127.") ||
    normalized === "::ffff:7f00:1"
  );
}

function answerLookup(
  hostname: string,
  options: unknown,
  callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
): boolean {
  const address = connectAddress.get(hostname);
  if (!address) return false;
  const all =
    typeof options === "object" &&
    options !== null &&
    "all" in options &&
    (options as { all?: boolean }).all === true;
  if (all) callback(null, [{ address, family: 4 }]);
  else callback(null, address, 4);
  return true;
}

// Node's HTTP client looks names up through dns.lookup at connect time (Node 22.23.4
// lib/net.js lookupAndConnect). A pre-check via promises or resolve4 sees a public address
// for the rebinding name, then the connect lookup still answers loopback.
dns.lookup = ((hostname: string, options: unknown, callback: unknown) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const done = callback as (
    error: NodeJS.ErrnoException | null,
    address: unknown,
    family?: number,
  ) => void;
  if (answerLookup(hostname, options, done)) return undefined;
  return originalLookup(hostname, options, done);
}) as typeof dns.lookup;

dns.resolve4 = ((hostname: string, options: unknown, callback: unknown) => {
  const done = (typeof options === "function" ? options : callback) as (
    error: NodeJS.ErrnoException | null,
    addresses: string[],
  ) => void;
  if (hostname === rebindingHost) {
    done(null, [publicAddress]);
    return undefined;
  }
  const resolveOptions = typeof options === "function" ? {} : options;
  return originalResolve4(hostname, resolveOptions, done);
}) as typeof dns.resolve4;

dns.promises.lookup = (async (hostname: string, options?: unknown) => {
  if (hostname === rebindingHost) {
    const all =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      (options as { all?: boolean }).all === true;
    return all ? [{ address: publicAddress, family: 4 }] : { address: publicAddress, family: 4 };
  }
  const address = connectAddress.get(hostname);
  if (address) return { address, family: 4 };
  return originalPromiseLookup(hostname, options as never);
}) as typeof dns.promises.lookup;

dns.promises.resolve4 = (async (hostname: string, options?: unknown) => {
  if (hostname === rebindingHost) return [publicAddress];
  return originalPromiseResolve4(hostname, options as never);
}) as typeof dns.promises.resolve4;

Socket.prototype.connect = function connect(this: Socket, ...args: never[]): Socket {
  const first: unknown = args[0];
  const host =
    typeof first === "object" && first !== null && "host" in first
      ? String((first as { host?: unknown }).host ?? "")
      : "";
  // A fix that pinned the public address from the pre-check must not open that socket.
  if (host === publicAddress) {
    queueMicrotask(() => this.destroy(new Error("refused non-local connect")));
    return this;
  }
  if (host && netIsIp(host) && !localAddress(host)) {
    queueMicrotask(() => this.destroy(new Error("refused non-local connect")));
    return this;
  }
  return (originalConnect as (this: Socket, ...args: never[]) => Socket).apply(this, args);
} as typeof Socket.prototype.connect;

function netIsIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

afterAll(() => {
  dns.lookup = savedLookup;
  dns.resolve4 = savedResolve4;
  dns.promises.lookup = originalPromiseLookup;
  dns.promises.resolve4 = originalPromiseResolve4;
  Socket.prototype.connect = originalConnect;
});

function listen(host: string, tls: boolean): Promise<Sink> {
  const hits: Hit[] = [];
  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      hits.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("stored");
    });
  };
  const server = tls ? createHttpsServer(tlsMaterial, onRequest) : createHttpServer(onRequest);
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        hits,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function invocation(): ManagedInvocation {
  return {
    protocolVersion: 1,
    executionId,
    attempt: 1,
    input: { query: "synthetic request" },
    config: {},
    inputFiles: [],
    deadline: new Date(Date.now() + 8000).toISOString(),
    traceparent: `00-${traceId}-1234567890abcdef-01`,
  };
}

async function runManaged(uploadUrl: string): Promise<{ filePosts: number; targetCalls: number }> {
  const posts: string[] = [];
  let targetCalls = 0;
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      if (request.method === "POST" && path.endsWith("/files")) posts.push(path);
      response.writeHead(200, { "content-type": "application/json" });
      if (path.endsWith("/claim")) {
        response.end(JSON.stringify({ claimed: true, executionId, state: "running" }));
        return;
      }
      if (path.endsWith("/files")) {
        response.end(
          JSON.stringify({
            artifactId: fileId,
            state: "pending",
            uploadUrl,
            headers: { "x-vercel-blob-access": "private" },
          }),
        );
        return;
      }
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiPort = (server.address() as { port: number }).port;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.hostname === apiHost) {
      url.protocol = "http:";
      url.hostname = "127.0.0.1";
      url.port = String(apiPort);
      return nativeFetch(url, init);
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const exported = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: exported })],
  });
  try {
    const handler = createManagedTargetHandler({
      baseUrl: `https://${apiHost}`,
      machineCredential: "synthetic-machine",
      tracer: provider.getTracer("upload-destination"),
      target: () => {
        targetCalls += 1;
        return Promise.resolve({
          output: "synthetic model output",
          files: [
            {
              filename: "answer.txt",
              contentType: "text/plain",
              data: output,
              primary: true,
            },
          ],
        });
      },
      flushTelemetry: () => Promise.resolve(),
    });
    await handler(
      new Request(`https://${apiHost}/target`, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-machine",
          "x-hue-invocation-token": "synthetic-scoped-token",
        },
        body: JSON.stringify(invocation()),
      }),
    );
    return { filePosts: posts.length, targetCalls };
  } finally {
    globalThis.fetch = nativeFetch;
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    server.closeAllConnections();
    server.close();
  }
}

async function expectKept(uploadUrl: string, sink: Sink): Promise<void> {
  const ran = await runManaged(uploadUrl);
  expect(ran.targetCalls).toBe(1);
  expect(ran.filePosts).toBe(1);
  expect(sink.hits).toEqual([]);
}

describe("managed output upload destination", () => {
  test("a remote managed API cannot PUT output to loopback HTTP", async () => {
    const sink = await listen("127.0.0.1", false);
    try {
      await expectKept(`http://127.0.0.1:${sink.port}/out`, sink);
    } finally {
      await sink.close();
    }
  });

  test("a remote managed API cannot PUT output to localhost", async () => {
    const sink = await listen("127.0.0.1", false);
    try {
      await expectKept(`http://localhost:${sink.port}/out`, sink);
    } finally {
      await sink.close();
    }
  });

  test("a remote managed API cannot PUT output to IPv6 loopback", async () => {
    const sink = await listen("::1", false);
    try {
      await expectKept(`http://[::1]:${sink.port}/out`, sink);
    } finally {
      await sink.close();
    }
  });

  test("a remote managed API cannot PUT output through a rewritten loopback spelling", async () => {
    const sink = await listen("127.0.0.1", false);
    const v6 = await listen("::1", false);
    try {
      await expectKept(`http://127.1:${sink.port}/out`, sink);
      await expectKept(`http://0x7f.0.0.1:${sink.port}/out`, sink);
      await expectKept(`http://[0::1]:${v6.port}/out`, v6);
    } finally {
      await sink.close();
      await v6.close();
    }
  });

  test("a remote managed API cannot PUT output to an HTTPS loopback address", async () => {
    const sink = await listen("127.0.0.1", true);
    const other = await listen("127.0.0.2", true);
    try {
      await expectKept(`https://127.0.0.1:${sink.port}/out`, sink);
      await expectKept(`https://127.1:${sink.port}/out`, sink);
      await expectKept(`https://127.0.0.2:${other.port}/out`, other);
      await expectKept(`https://[::ffff:127.0.0.1]:${sink.port}/out`, sink);
    } finally {
      await sink.close();
      await other.close();
    }
  });

  test("a name that first resolves in public and then to loopback does not receive the file", async () => {
    const sink = await listen("127.0.0.1", true);
    try {
      await expectKept(`https://${rebindingHost}:${sink.port}/out`, sink);
    } finally {
      await sink.close();
    }
  });
});

describe("evaluation artifact upload destination", () => {
  const client = createEvaluationClient({
    apiKey: "synthetic-project-key",
    baseUrl: `https://${apiHost}`,
  });
  const capability = (uploadUrl: string) => ({
    uploadUrl,
    method: "PUT" as const,
    headers: { "content-type": "text/plain" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  async function expectRefused(uploadUrl: string, sink: Sink): Promise<void> {
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await expect(
        client.uploadArtifactBytes(capability(uploadUrl), output, "text/plain"),
      ).rejects.toBeInstanceOf(HueApiError);
      expect(sink.hits).toEqual([]);
    } finally {
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    }
  }

  test("a remote evaluation origin cannot PUT artifact bytes to loopback or another HTTPS host", async () => {
    const httpSink = await listen("127.0.0.1", false);
    const v6 = await listen("::1", false);
    const httpsSink = await listen("127.0.0.1", true);
    const other = await listen("127.0.0.2", true);
    try {
      // fetch connects to these addresses directly. A name would not, under bun's resolver.
      await expectRefused(`http://127.0.0.1:${httpSink.port}/out`, httpSink);
      await expectRefused(`http://127.1:${httpSink.port}/out`, httpSink);
      await expectRefused(`http://[::1]:${v6.port}/out`, v6);
      await expectRefused(`https://127.0.0.1:${httpsSink.port}/out`, httpsSink);
      await expectRefused(`https://127.0.0.2:${other.port}/out`, other);
    } finally {
      await httpSink.close();
      await v6.close();
      await httpsSink.close();
      await other.close();
    }
  });
});

describe("trace value upload destination", () => {
  async function expectKept(uploadUrl: string, sink: Sink): Promise<void> {
    const posts: string[] = [];
    const server = createHttpsServer(tlsMaterial, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const path = request.url ?? "";
        if (request.method === "POST" && path.endsWith("/blobs")) posts.push(path);
        const body = JSON.stringify({
          status: "upload",
          method: "PUT",
          url: uploadUrl,
          headers: { "content-type": "text/plain" },
          ref: { content_type: "text/plain" },
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const uploader = new BlobUploader({
      baseUrl: `https://${apiHost}:${port}`,
      apiKey: "synthetic-project-key",
      timeoutMillis: 5000,
      allowInsecureHttp: false,
      userAgent: "synthetic-test",
    });
    try {
      await uploader.store(
        traceId,
        "output",
        output,
        "text/plain",
        {
          sha256: createHash("sha256").update(output).digest("hex"),
          size: output.byteLength,
        },
        { deadline: Date.now() + 8000, wait: () => Promise.resolve(false) },
      );
      expect(posts).toHaveLength(1);
      expect(sink.hits).toEqual([]);
    } finally {
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
      server.closeAllConnections();
      server.close();
    }
  }

  test("a remote trace origin cannot PUT a value to loopback or a rebinding name", async () => {
    const httpSink = await listen("127.0.0.1", false);
    const named = await listen("127.0.0.1", true);
    try {
      await expectKept(`http://127.0.0.1:${httpSink.port}/out`, httpSink);
      await expectKept(`https://${rebindingHost}:${named.port}/out`, named);
    } finally {
      await httpSink.close();
      await named.close();
    }
  });
});
