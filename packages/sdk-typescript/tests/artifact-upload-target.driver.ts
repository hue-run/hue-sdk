/**
 * Child of `artifact-upload-target.test.ts`. The parent starts it with
 * `NODE_EXTRA_CA_CERTS` already set, because Bun only reads that when the process starts.
 * Prints one JSON object on stdout. A hit is a PUT whose body is the caller's file bytes.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { BlobUploader } from "../src/blobs.js";
import { createEvaluationClient, HueApiError } from "../src/evals/client.js";
import { uploadOutputFiles, type StagedOutputFile } from "../src/evals/files.js";
import { createManagedTargetHandler, type ManagedInvocation } from "../src/managed.js";

const cert = process.env.UPLOAD_TARGET_CERT ?? "";
const key = process.env.UPLOAD_TARGET_KEY ?? "";
const privateIp = process.env.UPLOAD_TARGET_PRIVATE_IP ?? "";
const marker = {
  direct: "direct-bytes",
  stream: "stream-bytes",
  round: "round-trip-bytes",
  caseFile: "case-file-bytes",
  managed: "managed-bytes",
  blob: "blob-bytes",
};
const markers = Object.values(marker);
const hits: { where: string; body: string }[] = [];
const apiSeen = { claim: 0, artifactUpload: 0, blobReserve: 0 };

function bodyText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
function note(where: string, bytes: Uint8Array): void {
  const body = bodyText(bytes);
  if (markers.some((item) => body.includes(item))) hits.push({ where, body });
}
const tls = { cert: Bun.file(cert), key: Bun.file(key) };
const http4 = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    note("http4", new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  },
});
const http6 = Bun.serve({
  hostname: "::1",
  port: 0,
  async fetch(request) {
    note("http6", new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  },
});
const https4 = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls,
  async fetch(request) {
    note("https4", new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  },
});

const artifactId = randomUUID();
const executionId = randomUUID();
const traceId = "1234567890abcdef1234567890abcdef";
function reservation(body: Record<string, unknown>, state: "reserved" | "ready") {
  return {
    id: artifactId,
    filename: body.filename,
    declaredContentType: body.contentType,
    declaredBytes: body.byteSize,
    declaredSha256: body.sha256,
    state,
    copyState: state === "ready" ? "acknowledged" : "none",
    verifiedBytes: state === "ready" ? body.byteSize : null,
    verifiedSha256: state === "ready" ? body.sha256 : null,
    failureCode: null,
  };
}
const uploadCapability = (uploadUrl: string, contentType: string) => ({
  uploadUrl,
  method: "PUT",
  headers: { "content-type": contentType, "x-vercel-blob-access": "private" },
  expiresAt: "2099-01-01T00:00:00.000Z",
});

const api = Bun.serve({
  hostname: privateIp,
  port: 0,
  tls,
  async fetch(request) {
    const url = new URL(request.url);
    const bytes = new Uint8Array(await request.arrayBuffer());
    note("api", bytes);
    const path = url.pathname;
    if (request.method === "POST" && path === "/api/v1/artifacts") {
      const body = JSON.parse(bodyText(bytes)) as Record<string, unknown>;
      return Response.json(reservation(body, "reserved"), { status: 201 });
    }
    if (request.method === "POST" && path === `/api/v1/artifacts/${artifactId}/upload`) {
      apiSeen.artifactUpload++;
      return Response.json(
        uploadCapability(`http://127.0.0.1:${http4.port}/from-api`, "text/plain"),
      );
    }
    if (path.startsWith(`/api/v1/artifacts/${artifactId}`))
      return Response.json(
        reservation(
          { filename: "case.txt", contentType: "text/plain", byteSize: 1, sha256: "ab" },
          "ready",
        ),
      );
    if (path.endsWith("/claim")) {
      apiSeen.claim++;
      return Response.json({ claimed: true, executionId, state: "running" });
    }
    if (path.endsWith("/files")) {
      return Response.json({
        artifactId,
        uploadUrl: `http://127.0.0.1:${http4.port}/managed`,
        headers: { "x-vercel-blob-access": "private" },
      });
    }
    if (path === "/api/v1/otlp/blobs" && request.method === "POST") {
      apiSeen.blobReserve++;
      return Response.json({
        status: "upload",
        method: "PUT",
        url: `http://127.0.0.1:${http4.port}/blob`,
        headers: { "content-type": "text/plain" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        ref: { content_type: "text/plain" },
      });
    }
    return Response.json({});
  },
});

const origin = `https://${privateIp}:${api.port}`;
const remote = createEvaluationClient({
  apiKey: "synthetic-upload-key",
  baseUrl: "https://hue.invalid",
  maxAttempts: 1,
  timeoutMillis: 2000,
});
const hosted = createEvaluationClient({
  apiKey: "synthetic-upload-key",
  baseUrl: origin,
  maxAttempts: 1,
  timeoutMillis: 2000,
});
const direct = new TextEncoder().encode(marker.direct);
const capability = (
  uploadUrl: string,
): {
  uploadUrl: string;
  method: "PUT";
  headers: null;
  expiresAt: string;
} => ({
  uploadUrl,
  method: "PUT",
  headers: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
});

interface Operation {
  name: string;
  error: string | null;
  hits: { where: string; body: string }[];
  apiReached: boolean | null;
}

async function run(
  name: string,
  body: () => Promise<void>,
  counter?: keyof typeof apiSeen,
): Promise<Operation> {
  const before = hits.length;
  const started = counter ? apiSeen[counter] : 0;
  let error: string | null = null;
  try {
    await body();
  } catch (caught) {
    error =
      caught instanceof HueApiError
        ? "HueApiError"
        : caught instanceof Error
          ? caught.name
          : "error";
  }
  return {
    name,
    error,
    hits: hits.slice(before),
    apiReached: counter ? apiSeen[counter] > started : null,
  };
}

const httpTargets = [
  `http://127.0.0.1:${http4.port}/steal`,
  `http://localhost:${http4.port}/local`,
  `http://[::1]:${http6.port}/v6`,
  `http://2130706433:${http4.port}/decimal`,
  `http://127.1:${http4.port}/short`,
  `http://0x7f000001:${http4.port}/hex`,
  `http://0177.0.0.1:${http4.port}/octal`,
];
const httpsTargets = [
  `https://127.0.0.1:${https4.port}/secret`,
  `https://2130706433:${https4.port}/decimal`,
  `https://0177.0.0.1:${https4.port}/octal`,
  `https://${privateIp}:${api.port}/arbitrary`,
];

const operations: Operation[] = [];
for (const uploadUrl of httpTargets) {
  operations.push(
    await run(
      `uploadArtifactBytes ${uploadUrl.split(String(http4.port)).join("PORT").split(String(http6.port)).join("PORT")}`,
      () => remote.uploadArtifactBytes(capability(uploadUrl), direct, "text/plain"),
    ),
  );
}
for (const uploadUrl of httpsTargets) {
  operations.push(
    await run(
      `uploadArtifactBytes ${uploadUrl.replace(String(https4.port), "PORT").replace(String(api.port), "PORT")}`,
      () => remote.uploadArtifactBytes(capability(uploadUrl), direct, "text/plain"),
    ),
  );
}
operations.push(
  await run("uploadArtifactStream", () =>
    remote.uploadArtifactStream(
      capability(`http://127.0.0.1:${http4.port}/stream`),
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(marker.stream));
          controller.close();
        },
      }),
      marker.stream.length,
      "text/plain",
    ),
  ),
);
operations.push(
  await run(
    "requestArtifactUpload",
    async () => {
      const upload = await hosted.requestArtifactUpload(artifactId);
      await hosted.uploadArtifactBytes(
        upload,
        new TextEncoder().encode(marker.round),
        "text/plain",
      );
    },
    "artifactUpload",
  ),
);

const directory = await mkdtemp(join(tmpdir(), "hue-case-"));
const casePath = join(directory, "case.txt");
const caseBytes = Buffer.from(marker.caseFile);
await writeFile(casePath, caseBytes);
const staged: StagedOutputFile = {
  filename: "case.txt",
  contentType: "text/plain",
  byteSize: caseBytes.byteLength,
  sha256: createHash("sha256").update(caseBytes).digest("hex"),
  path: casePath,
  primary: true,
};
operations.push(
  await run(
    "uploadOutputFiles",
    () =>
      uploadOutputFiles(hosted, executionId, [staged], async () => undefined, {
        settleMillis: 1000,
        pollMillis: 10,
        maxPollMillis: 10,
      }),
    "artifactUpload",
  ),
);

const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })],
});
const invocation = (): ManagedInvocation => ({
  protocolVersion: 1,
  executionId,
  attempt: 1,
  input: { query: "synthetic" },
  config: {},
  inputFiles: [],
  deadline: new Date(Date.now() + 15_000).toISOString(),
  traceparent: `00-${traceId}-1234567890abcdef-01`,
});
operations.push(
  await run(
    "managed output file",
    async () => {
      const handler = createManagedTargetHandler({
        baseUrl: origin,
        machineCredential: "synthetic-machine",
        tracer: provider.getTracer("upload-target"),
        target: async () => ({
          output: "done",
          files: [
            {
              filename: "answer.bin",
              contentType: "application/octet-stream",
              data: new TextEncoder().encode(marker.managed),
              primary: true,
            },
          ],
        }),
        flushTelemetry: async () => ({ pendingSpans: 0, pendingLogs: 0 }),
      });
      await handler(
        new Request(`${origin}/target`, {
          method: "POST",
          headers: {
            authorization: "Bearer synthetic-machine",
            "x-hue-invocation-token": "synthetic-scoped-token",
          },
          body: JSON.stringify(invocation()),
        }),
      );
    },
    "claim",
  ),
);

const blobBytes = new TextEncoder().encode(marker.blob);
operations.push(
  await run(
    "blob store",
    async () => {
      const uploader = new BlobUploader({
        baseUrl: origin,
        apiKey: "synthetic-upload-key",
        timeoutMillis: 2000,
        allowInsecureHttp: false,
        userAgent: "synthetic",
      });
      await uploader.store(
        traceId,
        "event:hue.file:synthetic",
        blobBytes,
        "text/plain",
        {
          sha256: createHash("sha256").update(blobBytes).digest("hex"),
          size: blobBytes.byteLength,
        },
        { deadline: Date.now() + 10_000, wait: async () => false },
      );
      uploader.close();
    },
    "blobReserve",
  ),
);

http4.stop(true);
http6.stop(true);
https4.stop(true);
api.stop(true);
console.log(JSON.stringify({ operations }));
