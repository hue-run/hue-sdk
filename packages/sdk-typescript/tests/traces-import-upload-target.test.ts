import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ARTIFACT_PAYLOAD,
  IMPORT_PAYLOAD,
  WORLD_PAYLOAD,
  artifactHits,
  importHits,
  removeFixtures,
  worldHits,
} from "./traces-import-upload-target-fixture.ts";

const attackerHeaders = { "content-type": "application/json", "x-evil": "chosen" };
let previousTls: string | undefined;

beforeAll(() => {
  previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  // The HTTPS cases use a certificate minted in the test. The process is restored afterwards.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
});

afterAll(async () => {
  if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  await removeFixtures();
});

function refused(report: { state: string; error?: { code: string }; blobs: { stored: number } }) {
  expect(report.state).toBe("failed");
  expect(report.error?.code).toBe("protocol");
  expect(report.blobs.stored).toBe(0);
}

test("a remote import does not POST blob bytes to a loopback URL", async () => {
  const { hits, report } = await importHits(
    "127.0.0.1",
    (port) => ({
      url: `http://127.0.0.1:${port}/sink/chosen?x=1`,
      method: "POST",
      headers: attackerHeaders,
    }),
    IMPORT_PAYLOAD,
  );
  expect(hits).toEqual([]);
  refused(report);
});

test("a remote import does not PUT blob bytes when the reservation omits the method", async () => {
  const { hits, report } = await importHits(
    "127.0.0.1",
    (port) => ({
      url: `http://127.0.0.1:${port}/sink/chosen`,
      headers: attackerHeaders,
    }),
    IMPORT_PAYLOAD,
  );
  expect(hits).toEqual([]);
  refused(report);
});

test("a remote import does not send blob bytes to localhost", async () => {
  const { hits, report } = await importHits(
    "::",
    (port) => ({
      url: `http://localhost:${port}/sink/chosen`,
      method: "PUT",
      headers: attackerHeaders,
    }),
    IMPORT_PAYLOAD,
  );
  expect(hits).toEqual([]);
  refused(report);
});

test("a remote import does not send blob bytes to ipv6 loopback", async () => {
  const { hits, report } = await importHits(
    "::1",
    (port) => ({
      url: `http://[::1]:${port}/sink/chosen`,
      method: "DELETE",
      headers: attackerHeaders,
    }),
    IMPORT_PAYLOAD,
  );
  expect(hits).toEqual([]);
  refused(report);
});

test("a remote import does not send blob bytes to https on a loopback address", async () => {
  const { hits, report } = await importHits(
    "127.0.0.1",
    (port) => ({
      url: `https://127.0.0.1:${port}/sink/chosen`,
      method: "PUT",
      headers: attackerHeaders,
    }),
    IMPORT_PAYLOAD,
    true,
  );
  expect(hits).toEqual([]);
  refused(report);
});

test("hue world create does not send file bytes to a loopback URL from a remote origin", async () => {
  const { hits, code } = await worldHits(
    "127.0.0.1",
    (port) => ({
      url: `http://127.0.0.1:${port}/sink/chosen?x=1`,
      method: "POST",
      headers: attackerHeaders,
    }),
    WORLD_PAYLOAD,
  );
  expect(hits).toEqual([]);
  expect(code).toBe(1);
});

test("an evaluation upload does not PUT artifact bytes to a loopback URL", async () => {
  const { hits, rejected } = await artifactHits(
    "127.0.0.1",
    (port) => `http://127.0.0.1:${port}/sink/chosen`,
    ARTIFACT_PAYLOAD,
  );
  expect(hits).toEqual([]);
  expect(rejected).toBe(true);
});

test("a remote origin does not send bytes to a hostname that resolves to a different address on the next lookup", async () => {
  const source = join(import.meta.dir, "fixtures/rebind-lookup.c");
  const library = join(import.meta.dir, "../.context/rebind-lookup.so");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(import.meta.dir, "../.context"), { recursive: true });
  const compiled = spawnSync("gcc", ["-shared", "-fPIC", "-o", library, source, "-ldl"], {
    encoding: "utf8",
  });
  expect(compiled.status).toBe(0);
  const added = spawnSync("sudo", ["ip", "addr", "add", "203.0.113.10/32", "dev", "lo"], {
    encoding: "utf8",
  });
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "const s=require('net').createServer();s.on('error',()=>process.exit(1));s.listen(0,'203.0.113.10',()=>s.close(()=>process.exit(0)));",
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0)
    throw new Error(`203.0.113.10 is not local (${added.stderr} ${probe.stderr})`);
  const runner = join(import.meta.dir, "traces-import-upload-target-rebind.ts");
  const child = spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    env: {
      ...process.env,
      LD_PRELOAD: library,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
  });
  if (child.status !== 0) throw new Error(`${child.stdout}\n${child.stderr}`);
  const results = JSON.parse(child.stdout) as unknown;
  if (!Array.isArray(results)) throw new Error(child.stdout);
  const byName = new Map<
    string,
    { hits: unknown[]; state?: string; code?: number; ok?: boolean; rejected?: boolean }
  >();
  for (const item of results) {
    if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string")
      throw new Error(child.stdout);
    if (!("hits" in item) || !Array.isArray(item.hits)) throw new Error(child.stdout);
    byName.set(item.name, item);
  }
  for (const name of [
    "import-rebind",
    "world-rebind",
    "blob-loopback",
    "blob-rebind",
    "artifact-rebind",
  ]) {
    const result = byName.get(name);
    if (!result) throw new Error(`missing ${name}`);
    expect(result.hits).toEqual([]);
  }
  expect(byName.get("import-rebind")?.state).toBe("failed");
  expect(byName.get("world-rebind")?.code).toBe(1);
  expect(byName.get("blob-loopback")?.ok).toBe(false);
  expect(byName.get("blob-rebind")?.ok).toBe(false);
  expect(byName.get("artifact-rebind")?.rejected).toBe(true);
});
