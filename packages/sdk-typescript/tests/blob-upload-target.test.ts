import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createServer as createHttp,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttps, request as httpsRequest } from "node:https";
import dns from "node:dns";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import tls from "node:tls";
import { gzipSync } from "node:zlib";
import { BlobUploader, digestOf } from "../src/blobs.js";
import { uploadTraceBundle } from "../src/cli/traces-import-upload.js";
import { runWorldCommand } from "../src/cli/world.js";

// A remote Hue origin (this name is not a loopback hostname) must not be able to aim a
// presigned PUT at loopback, at an arbitrary HTTPS host, or at a host whose second lookup
// differs from the address the first lookup returned. The recorded bytes are the failure.

const API_NAME = "hue-api.invalid";
const SINK_NAME = "hue-blob-sink.invalid";
const REBIND_NAME = "hue-rebind.invalid";
const PUBLIC_IP = "23.192.0.10";
const MARK = "# hue-blob-upload-target";
const PAYLOAD = Buffer.from("telemetry-blob-canary");
const IMPORT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const IMPORT_TOKEN = `hue_it_${"a".repeat(43)}`;
const WORLD_KEY = "hue_test_placeholder_key";

type Hit = { method: string; url: string; body: Buffer };

const quiet = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

function run(command: string, args: string[], input?: string): void {
  const result = spawnSync(command, args, { encoding: "utf8", input });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error}`,
    );
  }
}

function listen(
  server: ReturnType<typeof createHttp> | ReturnType<typeof createHttps>,
  host: string,
  port = 0,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server has no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function collector(): { hits: Hit[]; on: (req: IncomingMessage, res: ServerResponse) => void } {
  const hits: Hit[] = [];
  return {
    hits,
    on(req, res) {
      const chunks: Buffer[] = [];
      const hit: Hit = { method: req.method ?? "", url: req.url ?? "", body: Buffer.alloc(0) };
      hits.push(hit);
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        hit.body = Buffer.concat(chunks);
        res.writeHead(200);
        res.end();
      });
    },
  };
}

function rawPut(url: string, body: Buffer): Promise<void> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: "PUT",
        agent: false,
        headers: { "content-length": String(body.byteLength), "content-type": "text/plain" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("a remote Hue origin cannot aim recorded bytes at a server-chosen upload URL", async () => {
  // Bun's fetch reads the extra CA bundle at process start. The child is that process.
  if (process.env.HUE_BLOB_TARGET_INNER !== "1") {
    const driver = mkdtempSync(join(tmpdir(), "hue-blob-target-ca-"));
    try {
      run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        join(driver, "ca.key"),
        "-out",
        join(driver, "ca.pem"),
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=hue-blob-target-test",
      ]);
      run("openssl", [
        "req",
        "-newkey",
        "rsa:2048",
        "-keyout",
        join(driver, "sink.key"),
        "-out",
        join(driver, "sink.csr"),
        "-nodes",
        "-subj",
        `/CN=${SINK_NAME}`,
      ]);
      writeFileSync(
        join(driver, "sink.ext"),
        `subjectAltName=DNS:${API_NAME},DNS:${SINK_NAME},DNS:${REBIND_NAME}\n`,
      );
      run("openssl", [
        "x509",
        "-req",
        "-in",
        join(driver, "sink.csr"),
        "-CA",
        join(driver, "ca.pem"),
        "-CAkey",
        join(driver, "ca.key"),
        "-CAcreateserial",
        "-out",
        join(driver, "sink.pem"),
        "-days",
        "1",
        "-extfile",
        join(driver, "sink.ext"),
      ]);
      const result = spawnSync(
        process.execPath,
        ["test", "tests/blob-upload-target.test.ts", "--timeout", "30000"],
        {
          cwd: join(import.meta.dir, ".."),
          encoding: "utf8",
          timeout: 35_000,
          env: {
            ...process.env,
            HUE_BLOB_TARGET_INNER: "1",
            NODE_EXTRA_CA_CERTS: join(driver, "ca.pem"),
            HUE_BLOB_CERT: join(driver, "sink.pem"),
            HUE_BLOB_KEY: join(driver, "sink.key"),
          },
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `upload-target cases failed (status ${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
        );
      }
    } finally {
      rmSync(driver, { recursive: true, force: true });
    }
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "hue-blob-target-"));
  const hits = {
    loop: collector(),
    named: collector(),
    public: collector(),
    rebound: collector(),
  };
  let httpApi: ReturnType<typeof createHttp> | undefined;
  let tlsApi: ReturnType<typeof createHttps> | undefined;
  let loopSink: ReturnType<typeof createHttp> | undefined;
  let namedSink: ReturnType<typeof createHttps> | undefined;
  let publicSink: ReturnType<typeof createHttps> | undefined;
  let reboundSink: ReturnType<typeof createHttps> | undefined;
  let grant = "";
  let reserves = 0;
  let imports = 0;
  let worlds = 0;
  const realLookup = dns.lookup;
  const realPromiseLookup = dns.promises.lookup;
  let lookups = 0;
  const failures: string[] = [];
  const hosts = readFileSync("/etc/hosts", "utf8");

  const answerIp = (hostname: string): string | undefined => {
    if (hostname !== REBIND_NAME) return undefined;
    lookups += 1;
    return lookups === 1 ? PUBLIC_IP : "127.0.0.1";
  };
  const installRebind = () => {
    lookups = 0;
    dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
      let opts = options as { all?: boolean } | undefined;
      let done = callback as
        | ((err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void)
        | undefined;
      if (typeof options === "function") {
        done = options as typeof done;
        opts = {};
      }
      const ip = answerIp(hostname);
      if (!ip || !done) return realLookup.call(dns, hostname, options as never, callback as never);
      if (opts?.all) done(null, [{ address: ip, family: 4 }]);
      else done(null, ip, 4);
      return {};
    }) as typeof dns.lookup;
    dns.promises.lookup = (async (hostname: string, options?: { all?: boolean }) => {
      const ip = answerIp(hostname);
      if (!ip) return realPromiseLookup.call(dns.promises, hostname, options as never);
      if (options?.all) return [{ address: ip, family: 4 }];
      return { address: ip, family: 4 };
    }) as typeof dns.promises.lookup;
  };

  try {
    const kept = hosts
      .split("\n")
      .filter(
        (line) => !line.includes(MARK) && !line.includes(API_NAME) && !line.includes(SINK_NAME),
      )
      .join("\n")
      .replace(/\n*$/, "\n");
    const hostsFile = join(root, "hosts");
    writeFileSync(hostsFile, `${kept}127.0.0.1 ${API_NAME} ${SINK_NAME} ${MARK}\n`);
    run("sudo", ["-n", "cp", hostsFile, "/etc/hosts"]);
    run("sudo", ["-n", "ip", "addr", "replace", `${PUBLIC_IP}/32`, "dev", "lo"]);
    const route = spawnSync("ip", ["route", "get", PUBLIC_IP], { encoding: "utf8" });
    if (route.status !== 0 || !route.stdout.includes("dev lo")) {
      throw new Error(`${PUBLIC_IP} is not a local address; refusing to open a route to it`);
    }

    const certPath = process.env.HUE_BLOB_CERT;
    const keyPath = process.env.HUE_BLOB_KEY;
    const caPath = process.env.NODE_EXTRA_CA_CERTS;
    if (!certPath || !keyPath || !caPath)
      throw new Error("the CA bundle was not passed to the test");
    const ca = readFileSync(caPath, "utf8");
    const cert = readFileSync(certPath);
    const key = readFileSync(keyPath);
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), ca]);
    const tlsOptions = { cert, key };

    const readJson = (req: IncomingMessage) =>
      new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });
    const json = (res: ServerResponse, status: number, body: unknown) => {
      const encoded = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(encoded),
      });
      res.end(encoded);
    };

    httpApi = createHttp(async (req, res) => {
      await readJson(req);
      if ((req.url ?? "").includes("/complete")) {
        json(res, 200, {});
        return;
      }
      reserves += 1;
      json(res, 200, {
        status: "upload",
        method: "PUT",
        url: grant,
        headers: { "Content-Type": "text/plain" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        ref: { content_type: "text/plain" },
      });
    });
    tlsApi = createHttps(tlsOptions, async (req, res) => {
      const url = new URL(req.url ?? "/", "http://upload.invalid");
      await readJson(req);
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/v1/world-creations" && req.method === "POST") {
        worlds += 1;
        json(res, 201, {
          worldCreation: { id: "6f9c1e2a-4b3d-4c5e-8f70-1a2b3c4d5e6f", status: "uploading" },
          uploads: [
            {
              app: "linear",
              file: 1,
              urlKey: "uploadUrl",
              method: "PUT",
              uploadHeaders: { "content-type": "application/octet-stream" },
            },
          ],
          uploadUrl: grant,
        });
        return;
      }
      if (url.pathname.endsWith("/uploaded")) {
        json(res, 200, {
          worldCreation: { id: "6f9c1e2a-4b3d-4c5e-8f70-1a2b3c4d5e6f", status: "importing" },
        });
        return;
      }
      if (url.pathname.endsWith("/manifest")) {
        imports += 1;
        json(res, 201, { trace_import: { id: IMPORT_ID, state: "registered" }, registered: true });
        return;
      }
      if (url.pathname.endsWith("/blobs")) {
        json(res, 200, {
          status: "upload",
          method: "PUT",
          url: grant,
          headers: { "Content-Type": "text/plain" },
        });
        return;
      }
      if (url.pathname.endsWith("/blobs/complete") || url.pathname.endsWith("/reconcile")) {
        json(res, 200, {});
        return;
      }
      if (url.pathname.endsWith("/batches")) {
        json(res, 200, {});
        return;
      }
      if (url.pathname.endsWith("/receipt")) {
        json(res, 200, { missingSpanIds: [] });
        return;
      }
      if (url.pathname.endsWith("/complete")) {
        json(res, 200, { trace_import: { id: IMPORT_ID, state: "completed" } });
        return;
      }
      json(res, 404, { error: "not found" });
    });

    loopSink = createHttp(hits.loop.on);
    namedSink = createHttps(tlsOptions, hits.named.on);
    publicSink = createHttps(tlsOptions, hits.public.on);
    reboundSink = createHttps(tlsOptions, hits.rebound.on);
    const httpPort = await listen(httpApi, "127.0.0.1");
    const tlsPort = await listen(tlsApi, "127.0.0.1");
    const loopPort = await listen(loopSink, "127.0.0.1");
    const namedPort = await listen(namedSink, "127.0.0.1");
    const publicPort = await listen(publicSink, PUBLIC_IP);
    await listen(reboundSink, "127.0.0.1", publicPort);

    const health = await fetch(`https://${API_NAME}:${tlsPort}/health`);
    if (health.status !== 200) throw new Error(`API TLS probe returned ${health.status}`);
    await health.arrayBuffer();
    await rawPut(`https://${SINK_NAME}:${namedPort}/probe`, Buffer.from("probe"));
    if (hits.named.hits.length !== 1) throw new Error("named HTTPS sink was not reachable");
    hits.named.hits.length = 0;

    const upload = async (body: Buffer) => {
      const uploader = new BlobUploader({
        baseUrl: `http://${API_NAME}:${httpPort}`,
        apiKey: WORLD_KEY,
        timeoutMillis: 3_000,
        allowInsecureHttp: false,
        userAgent: "blob-upload-target-test",
      });
      try {
        const digest = await digestOf(body, Date.now() + 5_000);
        return await uploader.store("ab".repeat(16), "input.value", body, "text/plain", digest, {
          deadline: Date.now() + 8_000,
          wait: async () => false,
        });
      } finally {
        uploader.close();
      }
    };

    const delivered = (groups: Hit[][]) => groups.reduce((sum, group) => sum + group.length, 0);
    const clear = (groups: Hit[][]) => {
      for (const group of groups) group.length = 0;
    };
    const expectRefused = async (
      label: string,
      groups: Hit[][],
      seen: () => number,
      runCase: () => Promise<void>,
    ) => {
      clear(groups);
      const before = seen();
      try {
        await runCase();
      } catch {
        // A refusal may reject the call. Delivery is the failure, not the rejection.
      }
      if (seen() === before) failures.push(`${label}: the API reservation was never requested`);
      const landed = delivered(groups);
      if (landed !== 0)
        failures.push(`${label}: ${landed} server-chosen upload request(s) received the bytes`);
    };

    await expectRefused(
      "BlobUploader PUT to http://127.0.0.1",
      [hits.loop.hits],
      () => reserves,
      async () => {
        grant = `http://127.0.0.1:${loopPort}/blob`;
        await upload(PAYLOAD);
      },
    );

    await expectRefused(
      "BlobUploader enqueue PUT to http://127.0.0.1",
      [hits.loop.hits],
      () => reserves,
      async () => {
        grant = `http://127.0.0.1:${loopPort}/blob`;
        const uploader = new BlobUploader({
          baseUrl: `http://${API_NAME}:${httpPort}`,
          apiKey: WORLD_KEY,
          timeoutMillis: 3_000,
          allowInsecureHttp: false,
          userAgent: "blob-upload-target-test",
        });
        try {
          const digest = await digestOf(PAYLOAD, Date.now() + 5_000);
          const queued = uploader.enqueue(
            "cd".repeat(16),
            "input.value",
            PAYLOAD,
            "text/plain",
            digest,
          );
          if (!queued.ok) throw new Error(`enqueue refused before the request: ${queued.reason}`);
          await queued.done;
        } finally {
          uploader.close();
        }
      },
    );

    await expectRefused(
      `BlobUploader PUT to https://${SINK_NAME}`,
      [hits.named.hits],
      () => reserves,
      async () => {
        grant = `https://${SINK_NAME}:${namedPort}/blob`;
        await upload(PAYLOAD);
      },
    );

    installRebind();
    try {
      lookups = 0;
      clear([hits.public.hits, hits.rebound.hits]);
      await rawPut(`https://${REBIND_NAME}:${publicPort}/probe`, Buffer.from("one"));
      await rawPut(`https://${REBIND_NAME}:${publicPort}/probe`, Buffer.from("two"));
      if (hits.public.hits.length !== 1 || hits.rebound.hits.length !== 1)
        throw new Error(
          `rebinding probe missed a listener (public ${hits.public.hits.length}, loop ${hits.rebound.hits.length}, lookups ${lookups})`,
        );
      await expectRefused(
        `BlobUploader PUT to https://${REBIND_NAME} (first lookup ${PUBLIC_IP}, later lookups 127.0.0.1)`,
        [hits.public.hits, hits.rebound.hits],
        () => reserves,
        async () => {
          lookups = 0;
          grant = `https://${REBIND_NAME}:${publicPort}/blob`;
          await upload(PAYLOAD);
        },
      );
    } finally {
      dns.lookup = realLookup;
      dns.promises.lookup = realPromiseLookup;
    }

    const bundleFor = async (body: Buffer) => {
      const directory = mkdtempSync(join(root, "bundle-"));
      const sha = createHash("sha256").update(body).digest("hex");
      const batch = gzipSync(Buffer.from('{"resourceSpans":[]}'));
      const batchSha = createHash("sha256").update(batch).digest("hex");
      const traceId = "12".repeat(16);
      const manifest = {
        version: 1,
        source: { formats: ["otlp_json"], helper: "blob-upload-target-test" },
        traces: [
          {
            trace_id: traceId,
            span_count: 1,
            origin: "unknown",
            batches: [{ sha256: batchSha, bytes: batch.byteLength, span_count: 1 }],
            blobs: [{ sha256: sha, byte_size: body.byteLength, content_type: "text/plain" }],
          },
        ],
      };
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(directory, `${sha}.blob`), body);
      writeFileSync(join(directory, `${traceId}.${batchSha}.json.gz`), batch);
      return directory;
    };
    const importUrl = `https://${API_NAME}:${tlsPort}/api/v1/trace-imports/${IMPORT_ID}`;
    await expectRefused(
      "trace import PUT to http://127.0.0.1",
      [hits.loop.hits],
      () => imports,
      async () => {
        grant = `http://127.0.0.1:${loopPort}/import`;
        await uploadTraceBundle(
          {
            directory: await bundleFor(Buffer.from("import-blob-canary")),
            token: IMPORT_TOKEN,
            importUrl,
          },
          { onInterrupt: () => () => {}, progress: () => {} },
        );
      },
    );
    await expectRefused(
      `trace import PUT to https://${SINK_NAME}`,
      [hits.named.hits],
      () => imports,
      async () => {
        grant = `https://${SINK_NAME}:${namedPort}/import`;
        await uploadTraceBundle(
          {
            directory: await bundleFor(Buffer.from("import-blob-canary-https")),
            token: IMPORT_TOKEN,
            importUrl,
          },
          { onInterrupt: () => () => {}, progress: () => {} },
        );
      },
    );

    const worldFiles = mkdtempSync(join(root, "world-"));
    writeFileSync(join(worldFiles, "notes.json"), Buffer.from("world-file-canary"));
    const world = () =>
      runWorldCommand(
        [
          "create",
          "--apps",
          "linear",
          "--files",
          worldFiles,
          "--origin",
          `https://${API_NAME}:${tlsPort}`,
          "--wait",
          "0",
        ],
        {
          stdout: quiet,
          stderr: quiet,
          cwd: root,
          env: { ...process.env, HUE_API_KEY: WORLD_KEY },
          onInterrupt: () => () => {},
        },
      );
    await expectRefused(
      "hue world PUT to http://127.0.0.1",
      [hits.loop.hits],
      () => worlds,
      async () => {
        grant = `http://127.0.0.1:${loopPort}/world`;
        await world();
      },
    );
    await expectRefused(
      `hue world PUT to https://${SINK_NAME}`,
      [hits.named.hits],
      () => worlds,
      async () => {
        grant = `https://${SINK_NAME}:${namedPort}/world`;
        await world();
      },
    );

    expect(failures).toEqual([]);
  } finally {
    dns.lookup = realLookup;
    dns.promises.lookup = realPromiseLookup;
    for (const server of [httpApi, tlsApi, loopSink, namedSink, publicSink, reboundSink])
      server?.close();
    const restored = hosts
      .split("\n")
      .filter(
        (line) => !line.includes(MARK) && !line.includes(API_NAME) && !line.includes(SINK_NAME),
      )
      .join("\n")
      .replace(/\n*$/, "\n");
    const restoreFile = join(root, "hosts.restore");
    try {
      writeFileSync(restoreFile, restored);
      spawnSync("sudo", ["-n", "cp", restoreFile, "/etc/hosts"]);
      spawnSync("sudo", ["-n", "ip", "addr", "del", `${PUBLIC_IP}/32`, "dev", "lo"]);
    } catch {
      // The assertion above is the result; cleanup must not hide it.
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
