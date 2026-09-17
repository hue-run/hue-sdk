import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  createManagedTargetHandler,
  type ManagedInvocation,
  type ManagedTargetOptions,
} from "../src/managed.js";

const executionId = "11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";
const traceId = "1234567890abcdef1234567890abcdef";
const bytes = Buffer.from("synthetic document bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const invocation = (): ManagedInvocation => ({
  protocolVersion: 1,
  executionId,
  attempt: 1,
  input: { query: "synthetic request" },
  config: {},
  inputFiles: [],
  deadline: new Date(Date.now() + 5000).toISOString(),
  traceparent: `00-${traceId}-1234567890abcdef-01`,
});
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function fixture() {
  const requests: Array<{ path: string; authorization?: string; body: Buffer }> = [];
  const outcomes: Record<string, unknown>[] = [];
  const exported = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: exported })],
  });
  let claimed = false;
  let outcomeCalls = 0;
  let claimCalls = 0;
  let hook: ((path: string) => number | "disconnect" | "hang" | undefined) | undefined;
  let ready = false;
  let uploadHeaders: Record<string, string> | null = { "x-vercel-blob-access": "private" };
  let uploadUrl: string | undefined;
  let uploaded: Buffer | undefined;
  let baseUrl = "";
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const path = req.url!;
    requests.push({ path, authorization: req.headers.authorization, body });
    if (path === "/upload" || path.startsWith("/upload?")) uploaded = body;
    const injected = hook?.(path);
    if (injected === "disconnect") {
      req.socket.destroy();
      return;
    }
    if (injected === "hang") {
      res.writeHead(200);
      res.write("x");
      return;
    }
    if (injected) {
      res.writeHead(injected);
      res.end("private server body must not escape");
      return;
    }
    res.setHeader("content-type", "application/json");
    if (path.endsWith("/claim")) {
      claimCalls++;
      res.end(JSON.stringify({ claimed: !claimed, executionId, state: "running" }));
      claimed = true;
    } else if (path.includes("/inputs/")) {
      res.end(bytes);
    } else if (path.endsWith("/files"))
      res.end(
        JSON.stringify(
          ready
            ? { artifactId: fileId, state: "ready" }
            : {
                artifactId: fileId,
                uploadUrl: uploadUrl ?? `${baseUrl}/upload`,
                headers: uploadHeaders,
              },
        ),
      );
    else if (path.endsWith("/complete") && (!uploaded || !uploaded.equals(bytes))) {
      res.writeHead(409);
      res.end("{}");
    } else if (path.endsWith("/outcome")) {
      outcomeCalls++;
      outcomes.push(JSON.parse(body.toString()));
      res.end("{}");
    } else res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let targetCalls = 0;
  const options: ManagedTargetOptions = {
    baseUrl,
    machineCredential: "synthetic-machine",
    tracer: provider.getTracer("test"),
    target: async () => {
      targetCalls++;
      return {
        output: "real callback output",
        files: [
          {
            filename: "answer.docx",
            contentType: "application/octet-stream",
            data: bytes,
            primary: true,
          },
        ],
      };
    },
    flushTelemetry: async () => {
      expect(outcomes.length).toBe(1);
      await provider.forceFlush();
    },
  };
  const request = (body: unknown = invocation(), auth = "Bearer synthetic-machine") =>
    new Request(`${baseUrl}/target`, {
      method: "POST",
      headers: { authorization: auth, "x-hue-invocation-token": "synthetic-scoped-token" },
      body: JSON.stringify(body),
    });
  return {
    options,
    request,
    requests,
    outcomes,
    exported,
    setHook: (value: typeof hook) => {
      hook = value;
    },
    setReady: () => {
      ready = true;
    },
    setUploadHeaders: (value: typeof uploadHeaders) => {
      uploadHeaders = value;
    },
    setUploadUrl: (value: string) => {
      uploadUrl = value;
    },
    calls: () => ({ targetCalls, claimCalls, outcomeCalls }),
  };
}

describe("managed target protocol", () => {
  test("claims once, uploads actual bytes without credentials, checkpoints actual span then flushes", async () => {
    const f = await fixture();
    const handler = createManagedTargetHandler(f.options);
    const response = await handler(f.request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      executionId,
      state: "checkpointed",
      telemetry: "flushed",
    });
    expect(f.outcomes[0]).toMatchObject({
      output: "real callback output",
      state: "succeeded",
      primaryArtifactId: fileId,
      artifactIds: [fileId],
      traceId,
    });
    const span = f.exported.getFinishedSpans()[0];
    expect(f.outcomes[0].expectedSpanIds).toEqual([span.spanContext().spanId]);
    expect(span.spanContext().traceId).toBe(traceId);
    expect(f.requests.find((r) => r.path === "/upload")).toMatchObject({
      authorization: undefined,
      body: bytes,
    });
    expect(
      f.requests
        .filter((r) => r.path !== "/upload")
        .every((r) => r.authorization === "Bearer synthetic-scoped-token"),
    ).toBe(true);
    expect((await handler(f.request())).status).toBe(409);
    expect(f.calls().targetCalls).toBe(1);
  });
  test("machine auth and invalid envelopes cause no egress", async () => {
    const f = await fixture();
    const handler = createManagedTargetHandler(f.options);
    expect((await handler(f.request(invocation(), "Bearer wrong"))).status).toBe(401);
    for (const body of [
      { ...invocation(), callbackUrl: "https://evil.test" },
      { ...invocation(), attempt: 0 },
      { ...invocation(), traceparent: `00-${traceId}-0000000000000000-01` },
    ])
      expect((await handler(f.request(body))).status).toBe(400);
    expect(f.requests).toHaveLength(0);
  });
  test("verifies input hashes before invoking target", async () => {
    const f = await fixture();
    let received: Uint8Array | undefined;
    f.options.target = async (value) => {
      received = value.inputFiles[0].data;
      return { output: null };
    };
    const body = {
      ...invocation(),
      inputFiles: [
        {
          artifactId: fileId,
          filename: "source.docx",
          contentType: "application/octet-stream",
          byteSize: bytes.length,
          sha256,
          role: "source",
        },
      ],
    };
    expect((await createManagedTargetHandler(f.options)(f.request(body))).status).toBe(200);
    expect(received).toEqual(bytes);
    expect(f.outcomes[0].output).toBeNull();
    const g = await fixture();
    body.inputFiles[0].sha256 = "0".repeat(64);
    expect((await createManagedTargetHandler(g.options)(g.request(body))).status).toBe(200);
    expect(g.calls().targetCalls).toBe(0);
    expect(g.outcomes[0].state).toBe("error");
  });
  test("claim response loss is uncertain and never retries claim or target", async () => {
    const f = await fixture();
    f.setHook(() => "disconnect");
    const response = await createManagedTargetHandler(f.options)(f.request());
    expect(response.status).toBe(503);
    expect(f.calls().targetCalls).toBe(0);
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-scoped");
  });
  test("checkpoint retry is identical and never reruns target", async () => {
    const f = await fixture();
    let failed = false;
    f.setHook((path) =>
      path.endsWith("/outcome") && !failed ? ((failed = true), "disconnect") : undefined,
    );
    expect((await createManagedTargetHandler(f.options)(f.request())).status).toBe(200);
    const attempts = f.requests.filter((r) => r.path.endsWith("/outcome"));
    expect(attempts).toHaveLength(2);
    expect(attempts[0].body).toEqual(attempts[1].body);
    expect(f.calls().targetCalls).toBe(1);
  });
  test("an error outcome still uploads valid files", async () => {
    const f = await fixture();
    f.options.target = async () => ({
      state: "error",
      error: { type: "missing_artifact" },
      files: [{ filename: "secondary.pptx", contentType: "application/octet-stream", data: bytes }],
    });
    expect((await createManagedTargetHandler(f.options)(f.request())).status).toBe(200);
    expect(f.outcomes[0]).toMatchObject({
      state: "error",
      artifactIds: [fileId],
      error: { type: "missing_artifact" },
    });
  });
  test("flush failure preserves accepted outcome and returns telemetry pending", async () => {
    const f = await fixture();
    f.options.flushTelemetry = async () => {
      throw new Error("private failure");
    };
    const response = await createManagedTargetHandler(f.options)(f.request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "checkpointed", telemetry: "pending" });
    expect(f.outcomes[0].state).toBe("succeeded");
  });
  test.each([false, { pendingSpans: 1, pendingLogs: 0 }, { pendingSpans: 0, pendingLogs: 1 }])(
    "flush result %p does not acknowledge delivery",
    async (flushResult) => {
      const f = await fixture();
      f.options.flushTelemetry = async () => flushResult;
      const response = await createManagedTargetHandler(f.options)(f.request());
      expect(await response.json()).toMatchObject({ state: "checkpointed", telemetry: "pending" });
      expect(f.outcomes[0].state).toBe("succeeded");
      expect(f.requests.some((r) => r.path.endsWith("/telemetry"))).toBe(false);
    },
  );
  test("historical report failures do not poison a completed current drain", async () => {
    const f = await fixture();
    f.options.flushTelemetry = async () => ({
      failedSpans: 1,
      rejectedLogs: 2,
      pendingSpans: 0,
      pendingLogs: 0,
    });
    const response = await createManagedTargetHandler(f.options)(f.request());
    expect(await response.json()).toMatchObject({ telemetry: "flushed" });
  });
  test("a budget exhausted during synchronous setup never starts the target", async () => {
    const f = await fixture();
    const tracer = f.options.tracer!;
    f.options.maxExecutionMillis = 30;
    f.options.tracer = Object.assign(Object.create(tracer), {
      startSpan: (...args: Parameters<typeof tracer.startSpan>) => {
        const span = tracer.startSpan(...args);
        const finish = Date.now() + 40;
        while (Date.now() < finish) {
          /* Simulate synchronous hashing/event-loop work. */
        }
        return span;
      },
    });
    const response = await createManagedTargetHandler(f.options)(f.request());
    expect(response.status).toBe(503);
    expect(f.calls().targetCalls).toBe(0);
    expect(f.outcomes).toHaveLength(0);
  });
  test.each(["traceparent", "deadline", "executionId"] as const)(
    "rejects trailing newline in %s before claiming",
    async (field) => {
      const f = await fixture();
      const body = invocation();
      body[field] += "\n";
      expect((await createManagedTargetHandler(f.options)(f.request(body))).status).toBe(400);
      expect(f.requests).toHaveLength(0);
    },
  );
  test("rejects a trailing newline in the declared file hash before claiming", async () => {
    const f = await fixture();
    const body = {
      ...invocation(),
      inputFiles: [
        {
          artifactId: fileId,
          filename: "source.docx",
          contentType: "application/octet-stream",
          byteSize: bytes.length,
          sha256: sha256 + "\n",
          role: "source",
        },
      ],
    };
    expect((await createManagedTargetHandler(f.options)(f.request(body))).status).toBe(400);
    expect(f.requests).toHaveLength(0);
  });
  test("unresolved target at deadline stays uncertain without false terminal checkpoint", async () => {
    const f = await fixture();
    f.options.maxExecutionMillis = 30;
    f.options.finalizationMillis = 20;
    f.options.target = async ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled"))),
      );
    const response = await createManagedTargetHandler(f.options)(f.request());
    expect(response.status).toBe(503);
    expect(f.outcomes).toHaveLength(0);
  });
  test("redirecting scoped input endpoint is rejected before callback", async () => {
    const f = await fixture();
    f.setHook((path) => (path.includes("/inputs/") ? 302 : undefined));
    const body = {
      ...invocation(),
      inputFiles: [
        {
          artifactId: fileId,
          filename: "source.docx",
          contentType: "application/octet-stream",
          byteSize: bytes.length,
          sha256,
          role: "source",
        },
      ],
    };
    expect((await createManagedTargetHandler(f.options)(f.request(body))).status).toBe(200);
    expect(f.calls().targetCalls).toBe(0);
    expect(f.outcomes[0].state).toBe("error");
  });
  test("ready reservations skip uploads and reuse verified bytes", async () => {
    const f = await fixture();
    f.setReady();
    expect((await createManagedTargetHandler(f.options)(f.request())).status).toBe(200);
    expect(f.requests.some((r) => r.path === "/upload" || r.path.endsWith("/complete"))).toBe(
      false,
    );
    expect(f.outcomes[0].primaryArtifactId).toBe(fileId);
  });
  test("unapproved upload credentials are rejected without losing output", async () => {
    const f = await fixture();
    f.setUploadHeaders({ authorization: "must-never-forward" });
    expect((await createManagedTargetHandler(f.options)(f.request())).status).toBe(200);
    expect(f.requests.some((r) => r.path === "/upload")).toBe(false);
    expect(f.outcomes[0]).toMatchObject({
      state: "error",
      output: "real callback output",
      artifactIds: [],
    });
  });
  test("input response body is included in the deadline", async () => {
    const f = await fixture();
    f.options.maxExecutionMillis = 50;
    f.setHook((path) => (path.includes("/inputs/") ? "hang" : undefined));
    const body = {
      ...invocation(),
      inputFiles: [
        {
          artifactId: fileId,
          filename: "source.docx",
          contentType: "application/octet-stream",
          byteSize: bytes.length,
          sha256,
          role: "source",
        },
      ],
    };
    const began = Date.now();
    expect((await createManagedTargetHandler(f.options)(f.request(body))).status).toBe(503);
    expect(Date.now() - began).toBeLessThan(500);
    expect(f.calls().targetCalls).toBe(0);
  });
  test("authoritative completion resolves a lost PUT acknowledgement", async () => {
    const f = await fixture();
    f.setHook((path) => (path === "/upload" ? 409 : undefined));
    expect((await createManagedTargetHandler(f.options)(f.request())).status).toBe(200);
    expect(f.requests.some((r) => r.path.endsWith("/complete"))).toBe(true);
    expect(f.outcomes[0]).toMatchObject({ state: "succeeded", primaryArtifactId: fileId });
  });
  test.each(["disconnect", 500, 421] as const)(
    "lost upload acknowledgement %s never replays a PUT",
    async (failure) => {
      const f = await fixture();
      f.setHook((path) => (path === "/upload" ? failure : undefined));
      expect((await createManagedTargetHandler(f.options)(f.request())).status).toBe(200);
      expect(f.requests.filter((r) => r.path === "/upload")).toHaveLength(1);
      expect(f.outcomes[0]).toMatchObject({ state: "succeeded", artifactIds: [fileId] });
      expect(f.calls().targetCalls).toBe(1);
    },
  );
  test("failed authoritative verification records upload failure without replaying the target or PUT", async () => {
    const f = await fixture();
    f.setHook((path) =>
      path === "/upload" ? "disconnect" : path.endsWith("/complete") ? 409 : undefined,
    );
    expect((await createManagedTargetHandler(f.options)(f.request())).status).toBe(200);
    expect(f.requests.filter((r) => r.path === "/upload")).toHaveLength(1);
    expect(f.outcomes[0]).toMatchObject({
      state: "error",
      artifactIds: [],
      error: { type: "artifact_upload_failed" },
    });
    expect(f.calls().targetCalls).toBe(1);
  });
  test("null upload headers use content type only", async () => {
    const f = await fixture();
    f.setUploadHeaders(null);
    expect((await createManagedTargetHandler(f.options)(f.request())).status).toBe(200);
    expect(f.requests.find((r) => r.path === "/upload")).toMatchObject({
      authorization: undefined,
      body: bytes,
    });
    expect(f.outcomes[0].state).toBe("succeeded");
  });
  test("the finalization deadline bounds a hanging upload response without replay", async () => {
    const f = await fixture();
    f.options.maxExecutionMillis = 100;
    f.options.finalizationMillis = 30;
    f.setHook((path) => (path === "/upload" ? "hang" : undefined));
    const started = Date.now();
    const response = await createManagedTargetHandler(f.options)(f.request());
    expect(response.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.requests.filter((r) => r.path === "/upload")).toHaveLength(1);
    expect(f.outcomes).toHaveLength(0);
  });
  test("preserves signed query bytes on the actual PUT request", async () => {
    const f = await fixture();
    const path = "/upload?signature=A%2fb+%2B&empty=&duplicate=x&duplicate=y";
    const signed = `${f.options.baseUrl}${path}`;
    f.setUploadUrl(signed);
    expect((await createManagedTargetHandler(f.options)(f.request())).status).toBe(200);
    expect(f.outcomes[0].state).toBe("succeeded");
    expect(f.requests.find((r) => r.path === path)).toMatchObject({
      authorization: undefined,
      body: bytes,
    });
  });
});
