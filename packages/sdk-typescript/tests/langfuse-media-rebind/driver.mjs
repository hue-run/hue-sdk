/**
 * Spec for the Langfuse media DNS-rebind gap.
 *
 * refusedDownload resolves a media hostname with dns/promises (no addrinfo hints) and allows the
 * URL when every answer is public. The download then calls global fetch, and Node's socket
 * lookup (node:net lookupAndConnect) resolves the name again with AI_ADDRCONFIG. This driver
 * answers those two lookups differently: every hints-0 lookup is 203.0.113.10, and every lookup
 * that carries AI_ADDRCONFIG is 169.254.169.254. A fix that looks the check path up again still
 * sees the public address. The download must connect to an address the check accepted.
 *
 * The private listener presents a certificate for the media hostname, which is what lets the
 * TLS handshake finish and the GET body reach TraceMedia. Exits 0 while the gap is open.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = "203.0.113.10";
const PRIVATE = "169.254.169.254";
const PRIVATE_BODY = "from-link-local-metadata-address";
const PUBLIC_BODY = "from-the-address-the-check-saw";
const HOSTS = {
  langfuse: "langfuse.example",
  cdn: "cdn.example",
  direct: "direct-rebind.test",
  redirected: "media-rebind.test",
};

const added = [];

function ensureAddress(address) {
  const show = execFileSync("/usr/sbin/ip", ["addr", "show", "dev", "lo"], { encoding: "utf8" });
  if (show.includes(`inet ${address}/`)) return;
  execFileSync("sudo", ["-n", "/usr/sbin/ip", "addr", "add", `${address}/32`, "dev", "lo"]);
  added.push(address);
}

function dropAddresses() {
  for (const address of added)
    execFileSync("sudo", ["-n", "/usr/sbin/ip", "addr", "del", `${address}/32`, "dev", "lo"]);
}

function normalize(address) {
  return address?.replace(/^::ffff:/u, "") ?? "";
}

function listen(address, port, tls, onHit) {
  const hits = [];
  const server = createServer(tls, (request, response) => {
    const hit = {
      local: normalize(request.socket.localAddress),
      host: request.headers.host ?? "",
      method: request.method ?? "",
      url: request.url ?? "",
    };
    hits.push(hit);
    onHit(request, response, hit);
  });
  server.on("clientError", () => undefined);
  server.on("tlsClientError", () => undefined);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => resolve({ server, hits, port: server.address().port }));
  });
}

async function main() {
  ensureAddress(PUBLIC);
  ensureAddress(PRIVATE);
  const dir = mkdtempSync(join(tmpdir(), "langfuse-rebind-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const library = join(dir, "getaddrinfo.so");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      `/CN=${HOSTS.langfuse}`,
      "-addext",
      `subjectAltName=DNS:${HOSTS.langfuse},DNS:${HOSTS.cdn},DNS:${HOSTS.direct},DNS:${HOSTS.redirected}`,
    ],
    { stdio: "ignore" },
  );
  execFileSync("gcc", ["-shared", "-fPIC", "-o", library, join(HERE, "getaddrinfo.c"), "-ldl"], {
    stdio: "ignore",
  });

  const material = { cert: readFileSync(cert), key: readFileSync(key) };

  let port = 0;
  const api = await listen("127.0.0.1", 0, material, (_req, response, hit) => {
    const id = hit.url.split("/").pop();
    const mediaHost = id === "redirect" ? HOSTS.cdn : HOSTS.direct;
    const body = JSON.stringify({
      mediaId: id,
      url: `https://${mediaHost}:${port}/object`,
    });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  port = api.port;
  const publicSide = await listen(PUBLIC, port, material, (_req, response, hit) => {
    if (hit.host.startsWith(HOSTS.cdn)) {
      response.writeHead(302, { location: `https://${HOSTS.redirected}:${port}/object` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(PUBLIC_BODY) });
    response.end(PUBLIC_BODY);
  });
  const privateSide = await listen(PRIVATE, port, material, (_req, response) => {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": Buffer.byteLength(PRIVATE_BODY),
    });
    response.end(PRIVATE_BODY);
  });

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
    env: {
      ...process.env,
      LD_PRELOAD: library,
      NODE_EXTRA_CA_CERTS: cert,
      REBIND_HOSTS: `${HOSTS.direct},${HOSTS.redirected}`,
      REBIND_PUBLIC: PUBLIC,
      REBIND_PRIVATE: PRIVATE,
      PINNED_HOSTS: `${HOSTS.langfuse}=127.0.0.1,${HOSTS.cdn}=${PUBLIC}`,
      MEDIA_PORT: String(port),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child timed out\n${stderr}\n${stdout}`));
    }, 20_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  api.server.close();
  publicSide.server.close();
  privateSide.server.close();

  const report = stdout.trim().split("\n").pop();
  let parsed;
  try {
    parsed = JSON.parse(report);
  } catch {
    console.error(stdout);
    console.error(stderr);
    throw new Error(`the child did not report a result (status ${status})`);
  }
  console.error(stderr);
  console.error(JSON.stringify({ child: parsed, private: privateSide.hits, public: publicSide.hits }, null, 2));

  for (const [name, seen] of [
    ["direct", parsed.direct.check],
    ["redirect", parsed.redirect.check],
  ]) {
    if (!seen.every((address) => address === PUBLIC))
      throw new Error(`${name} check lookup was ${seen.join(",")} ; the public answer was not set up`);
  }
  if (parsed.direct.connectLookup !== PRIVATE || parsed.redirect.connectLookup !== PRIVATE)
    throw new Error(
      `connect-style lookup was ${parsed.direct.connectLookup} and ${parsed.redirect.connectLookup}; the private answer was not set up`,
    );

  const privateGets = privateSide.hits.filter((hit) => hit.method === "GET");
  assert.deepEqual(
    privateGets,
    [],
    `media download sent ${privateGets.length} GET(s) to ${PRIVATE} after the check saw only ${PUBLIC}: ${JSON.stringify(privateGets)}`,
  );
  for (const name of ["direct", "redirect"]) {
    assert.notEqual(parsed[name].body, PRIVATE_BODY);
    assert.equal(parsed[name].uploaded.includes(PRIVATE_BODY), false);
  }
  dropAddresses();
  process.exit(0);
}

async function child() {
  const { lookup: lookupAll } = await import("node:dns/promises");
  const { lookup, ADDRCONFIG } = await import("node:dns");
  const { LangfuseApi, TraceMedia } = await import("../../dist/cli/langfuse.js");
  const port = process.env.MEDIA_PORT;
  const base = `https://${HOSTS.langfuse}:${port}`;

  const connectLookup = (host) =>
    new Promise((resolve, reject) => {
      lookup(host, { all: true, hints: ADDRCONFIG }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses.map((entry) => entry.address).join(","));
      });
    });

  async function run(id, host) {
    const checked = await lookupAll(host, { all: true });
    const again = await lookupAll(host, { all: true });
    const uploaded = [];
    const api = new LangfuseApi({
      baseUrl: base,
      publicKey: "pk-test",
      secretKey: "sk-test",
      sleep: async () => undefined,
      signal: new AbortController().signal,
    });
    const trace = new TraceMedia(
      api,
      {
        async store(_traceId, _key, bytes, contentType) {
          uploaded.push(Buffer.from(bytes).toString("utf8"));
          return { ok: true, contentType };
        },
      },
      "0123456789abcdef0123456789abcdef",
      () => ({ deadline: Date.now() + 60_000, wait: async () => undefined }),
    );
    let body;
    let error;
    try {
      const outcome = await trace.file({
        attribute: "langfuse.observation.input",
        token: { type: "text/plain", id, source: "bytes" },
        pointer: "",
        key: "input",
      });
      body =
        outcome.kind === "uploaded"
          ? uploaded.at(-1)
          : outcome.kind === "failed"
            ? undefined
            : outcome.kind;
      if (outcome.kind === "failed") error = outcome.reason;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      check: [...checked, ...again].map((entry) => entry.address),
      connectLookup: await connectLookup(host),
      body: body ?? null,
      error: error ?? null,
      uploaded,
    };
  }

  const direct = await run("direct", HOSTS.direct);
  const redirect = await run("redirect", HOSTS.redirected);
  process.stdout.write(`${JSON.stringify({ direct, redirect })}\n`);
}

const entry = process.argv.includes("--child") ? child() : main();
entry.catch((error) => {
  console.error(error);
  if (!process.argv.includes("--child")) dropAddresses();
  process.exit(1);
});
