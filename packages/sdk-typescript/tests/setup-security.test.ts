import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  SetupBackendAdapter,
  type SetupInstallationStatus,
  type SetupProbeEvidence,
} from "../src/setup/backend.js";
import {
  FileSetupInstallationStore,
  type SetupStoredCredential,
} from "../src/setup/installation.js";
import { acquireSetupCommandLock } from "../src/setup/lock.js";

const origin = "https://example.test";
const credential = (version: 0 | 1): SetupStoredCredential => ({
  apiKey: `hue_setup_test_setup-${String(version + 1).repeat(24)}_${"s".repeat(43)}`,
  keyId: `setup-${String(version + 1).repeat(24)}`,
  version,
  kind: "anonymous_trial",
  capabilities: ["setup_telemetry_write"],
});
const wire = credential;
const status = (installationId: string, version: 0 | 1): SetupInstallationStatus => ({
  protocolVersion: 1,
  installationId,
  state: version ? "claimed" : "active",
  project: { id: "project_test", organizationId: "org_test" },
  credentialVersion: version,
  capturePolicy: "metadata-only-v1",
  expiresAt: version ? null : new Date(Date.now() + 86400000).toISOString(),
  limits: { traces: 100, spans: 1000, bytes: 2097152 },
  usage: { traces: 0, spans: 0, bytes: 0 },
  claimHandoff: null,
  endpoints: { otlp: "/api/v1/otlp/v1/traces", receipt: "/api/v1/setup/traces/{traceId}/receipt" },
});

test("strict wire and stored credentials reject namespace, id and capability substitutions in both generations", async () => {
  for (const version of [0, 1] as const) {
    const good = wire(version);
    const variants = [
      { ...good, apiKey: good.apiKey.replace("hue_setup_", "hue_sk_") },
      { ...good, apiKey: good.apiKey.replace("hue_setup_", "hue_sk_").replace("setup-", "") },
      { ...good, apiKey: good.apiKey.replace("hue_setup_", "hue_other_") },
      { ...good, keyId: "setup-" + "f".repeat(24) },
      { ...good, keyId: good.keyId.replace("setup-", "") },
      { ...good, apiKey: good.apiKey + "x" },
      { ...good, apiKey: good.apiKey.toUpperCase() },
      { ...good, capabilities: ["telemetry_write"] },
      { ...good, capabilities: ["setup_telemetry_write", "telemetry_write"] },
      { ...good, kind: "ordinary" },
      { ...good, kind: undefined },
    ];
    for (const candidate of variants) {
      const root = await mkdtemp(join(tmpdir(), "hue-credential-refusal-"));
      const adapter = new SetupBackendAdapter({
        projectRoot: root,
        origin,
        fetch: (async () =>
          Response.json(
            { ...status((await adapter.prepare()).installationId, version), credential: candidate },
            { headers: { "Cache-Control": "no-store" } },
          )) as unknown as typeof fetch,
      });
      await expect(adapter.credentials(version)).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect((await adapter.localInstallation())?.credential === undefined).toBe(true);
      const record = await adapter.prepare();
      record.credential = candidate as SetupStoredCredential;
      await expect(adapter.store.save(record)).rejects.toThrow("Invalid setup installation record");
    }
    const root = await mkdtemp(join(tmpdir(), "hue-credential-valid-"));
    const store = new FileSetupInstallationStore(root, origin);
    const record = await store.loadOrCreate();
    record.credential = credential(version);
    await store.save(record);
    expect(
      (await new FileSetupInstallationStore(root, origin).load())?.credential?.apiKey ===
        good.apiKey,
    ).toBe(true);
  }
});

test("stale installation writers refuse actual concurrent replacement and permission edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "hue-installation-cas-"));
  const first = new FileSetupInstallationStore(root, origin);
  const a = await first.loadOrCreate();
  const second = new FileSetupInstallationStore(root, origin);
  const b = (await second.load())!;
  a.credential = credential(0);
  await first.save(a);
  b.credential = credential(1);
  await expect(second.save(b)).rejects.toThrow("concurrently changed");
  expect((await first.load())?.credential?.version).toBe(0);
  await chmod(first.path, 0o400);
  await expect(first.save(a)).rejects.toThrow("concurrently changed");
  await chmod(first.path, 0o600);
  const encoded = JSON.parse(await readFile(first.path, "utf8")) as Record<string, unknown>;
  encoded.credential = { ...credential(0), capabilities: ["telemetry_write"] };
  await writeFile(first.path, JSON.stringify(encoded), { mode: 0o600 });
  await expect(first.load()).rejects.toThrow("Invalid setup installation record");
});

test("project command lock excludes a real second process and releases for resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "hue-command-lock-"));
  const release = await acquireSetupCommandLock(root);
  const module = new URL("../src/setup/lock.ts", import.meta.url).href;
  const script = `import { acquireSetupCommandLock } from ${JSON.stringify(module)}; try { const release = await acquireSetupCommandLock(${JSON.stringify(root)}); await release(); process.exitCode = 3; } catch { process.exitCode = 0; }`;
  try {
    const result = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  } finally {
    await release();
  }
  await (
    await acquireSetupCommandLock(root)
  )();
});

test("a consumed live browser session is not rotated or exchanged by resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "hue-consumed-handoff-"));
  let network = 0;
  const adapter = new SetupBackendAdapter({
    projectRoot: root,
    origin,
    fetch: (async () => {
      network += 1;
      throw new Error("No request permitted");
    }) as unknown as typeof fetch,
  });
  const record = await adapter.prepare();
  const current = status(record.installationId, 0);
  current.claimHandoff = {
    id: "a".repeat(8) + "-aaaa-4aaa-8aaa-" + "a".repeat(12),
    state: "consumed",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    sessionExpiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const result = await adapter.prepareClaimHandoff(current, false);
  expect(result).toEqual({ opened: false, state: "consumed", restartRequired: false });
  expect(network).toBe(0);
});

test("transport exceptions and abort reasons cannot carry private proof into adapter errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "hue-private-errors-"));
  const canary = credential(0).apiKey;
  const adapter = new SetupBackendAdapter({
    projectRoot: root,
    origin,
    fetch: (async () => {
      throw new Error(canary);
    }) as unknown as typeof fetch,
  });
  let captured: unknown;
  try {
    await adapter.provision();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(Error);
  expect(String(captured).includes(canary)).toBe(false);
  expect((captured as Error).cause).toBeUndefined();
  const controller = new AbortController();
  controller.abort(new Error(canary));
  try {
    await adapter.status(controller.signal);
  } catch (error) {
    captured = error;
  }
  expect(String(captured).includes(canary)).toBe(false);
});

test("revocation fetch and body failures never expose credentials or mark revocation complete", async () => {
  const evidence = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
  } as SetupProbeEvidence;
  for (const boundary of ["fetch", "cancel", "abort", "redirect"] as const) {
    const root = await mkdtemp(join(tmpdir(), "hue-private-revocation-errors-"));
    const old = credential(0);
    const controller = new AbortController();
    let calls = 0;
    const adapter = new SetupBackendAdapter({
      projectRoot: root,
      origin,
      fetch: (async (input, init) => {
        calls += 1;
        expect(new URL(String(input)).pathname).toBe(
          `/api/v1/setup/traces/${evidence.traceId}/receipt`,
        );
        expect(init?.redirect).toBe("manual");
        if (boundary === "fetch") throw new Error(old.apiKey, { cause: old.apiKey });
        if (boundary === "abort") {
          controller.abort(new Error(old.apiKey));
          throw controller.signal.reason;
        }
        return new Response(
          new ReadableStream({
            cancel() {
              if (boundary === "cancel") throw new Error(old.apiKey, { cause: old.apiKey });
            },
          }),
          { status: boundary === "redirect" ? 302 : 401 },
        );
      }) as typeof fetch,
    });
    const installation = await adapter.prepare();
    installation.credential = credential(1);
    installation.revocationCredential = old;
    await adapter.store.save(installation);
    let captured: unknown;
    try {
      await adapter.verifyRevokedCredential(old.apiKey, evidence, controller.signal);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(String(captured).includes(old.apiKey)).toBe(false);
    expect((captured as Error).cause).toBeUndefined();
    expect(calls).toBe(1);
    const persisted = await adapter.store.load();
    expect(persisted?.anonymousKeyRevoked).toBeUndefined();
    expect(persisted?.revocationCredential?.version).toBe(0);
  }
});

test("lost explicit handoff restart retries its persisted id and original predecessor", async () => {
  const root = await mkdtemp(join(tmpdir(), "hue-handoff-restart-"));
  const predecessor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const next = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let requests = 0;
  const adapter = new SetupBackendAdapter({
    projectRoot: root,
    origin,
    fetch: (async (_input, init) => {
      requests += 1;
      expect(JSON.parse(String(init?.body))).toEqual({
        protocolVersion: 1,
        handoffId: next,
        previousHandoffId: predecessor,
      });
      return Response.json(
        { protocolVersion: 1, code: "SETUP_HANDOFF_LIMIT" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }) as typeof fetch,
  });
  const record = await adapter.prepare();
  record.claimHandoff = { id: next, previousHandoffId: predecessor };
  await adapter.store.save(record);
  const current = status(record.installationId, 0);
  current.claimHandoff = {
    id: predecessor,
    state: "expired",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    sessionExpiresAt: null,
  };
  await expect(adapter.prepareClaimHandoff(current, true, true)).rejects.toMatchObject({
    code: "SETUP_HANDOFF_LIMIT",
  });
  expect(requests).toBe(1);
  expect((await adapter.store.load())?.claimHandoff?.id).toBe(next);
});
