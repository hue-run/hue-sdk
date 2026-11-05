import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { configSchema, endedEvent, loginEvent, loginSchema } from "../src/contracts.ts";
import { Store } from "../src/store.ts";
import { Worker } from "../src/worker.ts";

const token = "synthetic-control-token-32-characters";
async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition_timeout");
    await delay(100);
  }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hue-hooks-"));
  const projectId = randomUUID();
  const worldId = randomUUID();
  let status = {
    projectId,
    worldId,
    lifecycle: "live",
    activity: "active",
    status: "open",
    sealedAt: null as string | null,
  };
  let statusCode = 200;
  let sessionId = randomUUID();
  let initializations = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    assert.equal(url.pathname, "/api/mcp");
    assert.equal(url.searchParams.get("project"), projectId);
    assert.equal(url.searchParams.get("read_only"), "true");
    assert.equal(request.headers.authorization, "Bearer synthetic-project-read-key");
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z
          .object({
            protocolVersion: z.string().optional(),
            name: z.string().optional(),
            arguments: z.unknown().optional(),
          })
          .optional(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (rpc.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (rpc.method === "initialize") {
      initializations++;
      response.setHeader("mcp-session-id", sessionId);
      result = {
        protocolVersion: rpc.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-hue-boundary", version: "1" },
      };
    } else {
      if (request.headers["mcp-session-id"] !== sessionId) {
        response.writeHead(404).end();
        return;
      }
      assert.equal(rpc.method, "tools/call");
      let structuredContent: unknown;
      if (rpc.params?.name === "list_projects")
        structuredContent = { projects: [{ id: status.projectId }] };
      else {
        assert.equal(rpc.params?.name, "get_instance");
        assert.deepEqual(rpc.params.arguments, { instance_id: worldId });
        structuredContent = {
          instance: {
            instance_id: status.worldId,
            lifecycle: status.lifecycle,
            activity: status.activity,
            status: status.status,
            sealed_at: status.sealedAt,
          },
        };
      }
      result = {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    response
      .writeHead(statusCode, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = configSchema.parse({
    origin: `http://127.0.0.1:${address.port}`,
    projectId,
    worldId,
    connectionId: "test-connection-1",
    command: [process.execPath, resolve("test/receiver.ts")],
    envNames: ["TEST_RECEIVER_DB"],
    port: 0,
  });
  const configFile = join(dir, "config.json");
  writeFileSync(configFile, JSON.stringify(config));
  const receiverFile = join(dir, "receiver.sqlite");
  const receiver = new DatabaseSync(receiverFile);
  receiver.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  receiver.exec(
    "CREATE TABLE control(mode TEXT); INSERT INTO control VALUES('ok'); CREATE TABLE receipts(id TEXT PRIMARY KEY,payload TEXT); CREATE TABLE connections(project_id TEXT,world_id TEXT,connection_id TEXT,PRIMARY KEY(project_id,world_id,connection_id)); CREATE TABLE terminal(project_id TEXT,world_id TEXT,connection_id TEXT,PRIMARY KEY(project_id,world_id,connection_id)); CREATE TABLE auth_effects(id TEXT PRIMARY KEY,outcome TEXT); CREATE TABLE active_adapters(pid INTEGER PRIMARY KEY); CREATE TABLE finance(balance INTEGER); INSERT INTO finance VALUES(250000);",
  );
  const insert = receiver.prepare("INSERT INTO connections VALUES(?,?,?)");
  insert.run(projectId, worldId, config.connectionId);
  insert.run(randomUUID(), worldId, config.connectionId);
  insert.run(projectId, randomUUID(), config.connectionId);
  const environment = {
    ...process.env,
    TEST_RECEIVER_DB: receiverFile,
    HUE_HOOK_STATUS_KEY: "synthetic-project-read-key",
    HUE_HOOK_CONTROL_TOKEN: token,
    HUE_API_KEY: "must-not-reach-adapter",
    HUE_OTHER_SECRET: "must-not-reach-adapter",
  };
  const stateDir = join(dir, "state");
  const children: ReturnType<typeof spawn>[] = [];
  async function start() {
    const child = spawn(
      process.execPath,
      [resolve("src/main.ts"), "--config", configFile, "--state-dir", stateDir],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (part) => {
      stdout += part;
    });
    child.stderr?.on("data", (part) => {
      stderr += part;
    });
    await until(
      () => stdout.includes("hooks.ready") || child.exitCode !== null || child.signalCode !== null,
    );
    assert.equal(child.exitCode, null, stderr);
    assert.equal(child.signalCode, null, stderr);
    const ready = z
      .object({ url: z.url() })
      .parse(JSON.parse(stdout.trim().split("\n")[0] ?? "null"));
    return { child, url: ready.url, stderr: () => stderr };
  }
  async function stop(child: ReturnType<typeof spawn>) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  return {
    dir,
    config,
    configFile,
    receiver,
    environment,
    stateDir,
    start,
    stop,
    mode: (value: string) => {
      receiver.prepare("UPDATE control SET mode=?").run(value);
    },
    seal: (value = "completed") => {
      status = {
        ...status,
        lifecycle: "sealed",
        activity: "inactive",
        status: value,
        sealedAt: new Date().toISOString(),
      };
    },
    wrongProject: () => {
      status = { ...status, projectId: randomUUID() };
    },
    wrongWorld: () => {
      status = { ...status, worldId: randomUUID() };
    },
    inactive: () => {
      status = { ...status, activity: "inactive" };
    },
    unavailable: (code = 503) => {
      statusCode = code;
    },
    available: () => {
      statusCode = 200;
    },
    expireSession: () => {
      sessionId = randomUUID();
    },
    initializations: () => initializations,
    cleanup: async () => {
      for (const child of children) await stop(child);
      for (const row of receiver.prepare("SELECT pid FROM active_adapters").all()) {
        try {
          process.kill(Number(row.pid), "SIGKILL");
        } catch {
          /* test adapter already exited */
        }
      }
      await new Promise<void>((done) => server.close(() => done()));
      receiver.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function post(url: string, body: unknown, credential = token) {
  return fetch(`${url}/auth/outcomes`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const login = { requestId: "request-1", subjectId: "user-1", stage: "oauth", outcome: "succeeded" };

test("typed outcomes use the real HTTP/child path, reject spoofed or conflicting requests, and exclude control credentials", async () => {
  const f = await fixture();
  try {
    const process = await f.start();
    assert.equal((await post(process.url, login, "wrong-token")).status, 401);
    assert.equal((await post(process.url, { ...login, projectId: randomUUID() })).status, 400);
    assert.equal((await post(process.url, { ...login, outcome: "maybe" })).status, 400);
    for (const [i, outcome] of ["succeeded", "rejected", "timed_out", "failed"].entries()) {
      assert.equal(
        (
          await post(process.url, {
            ...login,
            requestId: `request-${i}`,
            stage: ["oauth", "sso", "mfa", "oauth"][i],
            outcome,
          })
        ).status,
        202,
      );
    }
    assert.equal((await post(process.url, { ...login, requestId: "request-0" })).status, 202);
    assert.equal(
      (await post(process.url, { ...login, requestId: "request-0", outcome: "failed" })).status,
      409,
    );
    await until(
      () => Number(f.receiver.prepare("SELECT count(*) AS n FROM receipts").get()?.n) === 4,
      30_000,
    );
    assert.equal(f.receiver.prepare("SELECT balance FROM finance").get()?.balance, 250000);
    const deliveries = f.receiver
      .prepare("SELECT payload FROM receipts ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.payload)));
    assert.deepEqual(
      deliveries.map((event) => event.login.outcome),
      ["succeeded", "rejected", "timed_out", "failed"],
    );
    assert.deepEqual(
      deliveries.map((event) => event.login.stage),
      ["oauth", "sso", "mfa", "oauth"],
    );
    assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM connections").get()?.n, 3);
    assert.doesNotMatch(process.stderr(), /must-not-reach|private-receiver/);
  } finally {
    await f.cleanup();
  }
});

test(
  "cleanup survives a real process death after receiver commit, retries the same key and deletes only the scoped connection",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    try {
      f.mode("crash_after_apply");
      f.seal("expired");
      const first = await f.start();
      await until(() => first.child.signalCode === "SIGKILL");
      assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM receipts").get()?.n, 1);
      assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM connections").get()?.n, 2);
      const second = await f.start();
      await until(async () => {
        const response = await fetch(`${second.url}/status`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const value = z
          .object({ events: z.array(z.object({ state: z.string(), attempts: z.number() })) })
          .parse(await response.json());
        return value.events[0]?.state === "done" && value.events[0].attempts === 2;
      }, 40_000);
      assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM receipts").get()?.n, 1);
      assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM connections").get()?.n, 2);
      assert.equal(f.receiver.prepare("SELECT balance FROM finance").get()?.balance, 250000);
      assert.equal((await post(second.url, login)).status, 409);
    } finally {
      await f.cleanup();
    }
  },
);

test("failed or unacknowledged cleanup stays pending; auth work stops at seal; scope failures never call the adapter", async () => {
  const f = await fixture();
  const store = new Store(f.stateDir, f.config);
  const worker = new Worker(f.config, store, f.environment);
  try {
    store.enqueue(loginEvent(f.config, loginSchema.parse(login)));
    f.mode("no_ack");
    f.seal("abandoned");
    await worker.tick();
    assert.deepEqual(
      store.status().map((row) => row.state),
      ["cancelled", "pending"],
    );
    assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM connections").get()?.n, 3);
    f.mode("fail");
    await delay(5_050);
    await worker.tick();
    assert.equal(store.status()[1]?.state, "pending");
    f.unavailable();
    await assert.rejects(worker.world(), /world_status_unavailable/);
    f.available();
    assert.equal((await worker.world()).lifecycle, "sealed");
    assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM receipts").get()?.n, 0);
  } finally {
    await worker.close();
    store.close();
    await f.cleanup();
  }
  const wrong = await fixture();
  const wrongStore = new Store(wrong.stateDir, wrong.config);
  try {
    wrong.wrongProject();
    await assert.rejects(
      new Worker(wrong.config, wrongStore, wrong.environment).tick(),
      /world_scope_mismatch/,
    );
    assert.equal(wrong.receiver.prepare("SELECT count(*) AS n FROM receipts").get()?.n, 0);
    assert.throws(
      () => new Store(wrong.stateDir, { ...wrong.config, connectionId: "other" }),
      /state_binding_mismatch/,
    );
  } finally {
    wrongStore.close();
    await wrong.cleanup();
  }
});

test("expired MCP sessions reconnect repeatedly and revalidate project scope", async () => {
  const f = await fixture();
  const store = new Store(f.stateDir, f.config);
  const worker = new Worker(f.config, store, f.environment);
  try {
    assert.equal((await worker.world()).activity, "active");
    for (let attempt = 0; attempt < 3; attempt++) {
      f.expireSession();
      await assert.rejects(worker.world(), /world_status_unavailable/);
      assert.equal((await worker.world()).activity, "active");
      assert.equal(f.initializations(), attempt + 2);
    }
    f.expireSession();
    await assert.rejects(worker.world(), /world_status_unavailable/);
    f.wrongProject();
    await assert.rejects(worker.world(), /world_scope_mismatch/);
    assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM receipts").get()?.n, 0);
  } finally {
    await worker.close();
    store.close();
    await f.cleanup();
  }
});

test("saved cleanup retries after restart when the MCP credential is refused", async () => {
  const f = await fixture();
  try {
    f.mode("fail");
    f.seal();
    const first = await f.start();
    const store = new Store(f.stateDir, f.config);
    await until(() => store.status()[0]?.error === "adapter_failed");
    assert.equal(store.status()[0]?.state, "pending");
    await f.stop(first.child);
    f.unavailable(403);
    f.mode("ok");
    const second = await f.start();
    await until(() => store.status()[0]?.state === "done");
    assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM connections").get()?.n, 2);
    assert.equal((await post(second.url, login)).status, 409);
    store.close();
  } finally {
    await f.cleanup();
  }
});

test("concurrent queue inserts preserve the visible terminal cleanup slot", async () => {
  const f = await fixture();
  const store = new Store(f.stateDir, f.config);
  const children: ReturnType<typeof spawn>[] = [];
  try {
    for (let i = 0; i < 998; i++)
      store.enqueue(loginEvent(f.config, loginSchema.parse({ ...login, requestId: `seed-${i}` })));
    const workers = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const child = spawn(
          process.execPath,
          [resolve("test/enqueue.ts"), f.configFile, f.stateDir, `concurrent-${i}`],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        children.push(child);
        let output = "";
        let error = "";
        child.stdout?.on("data", (part) => {
          output += part;
        });
        child.stderr?.on("data", (part) => {
          error += part;
        });
        const finished = once(child, "exit");
        await until(() => output.includes("ready") || child.exitCode !== null);
        assert.equal(child.exitCode, null, error);
        return { child, finished, output: () => output, error: () => error };
      }),
    );
    for (const worker of workers) worker.child.stdin?.end("go");
    for (const worker of workers) {
      await worker.finished;
      assert.equal(worker.child.exitCode, 0, worker.error());
    }
    assert.equal(workers.filter((worker) => worker.output().includes("accepted")).length, 1);
    assert.equal(store.status().length, 999);
    store.enqueue(
      endedEvent(f.config, {
        projectId: f.config.projectId,
        worldId: f.config.worldId,
        lifecycle: "sealed",
        activity: "inactive",
        status: "completed",
        sealedAt: new Date().toISOString(),
      }),
    );
    assert.equal(store.status().length, 1000);
    assert.equal(store.status()[999]?.kind, "world.ended");
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    store.close();
    await f.cleanup();
  }
});

test("an inactive but unsealed World admits no login effects and is not treated as cleaned up", async () => {
  const f = await fixture();
  const store = new Store(f.stateDir, f.config);
  try {
    store.enqueue(loginEvent(f.config, loginSchema.parse(login)));
    f.inactive();
    const helper = await f.start();
    assert.equal((await post(helper.url, { ...login, requestId: "new-attempt" })).status, 409);
    await delay(5500);
    assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM receipts").get()?.n, 0);
    assert.equal(store.status()[0]?.state, "pending");
    assert.equal(store.terminal(), null);
    f.seal("expired");
    await until(() =>
      store.status().some((row) => row.kind === "world.ended" && row.state === "done"),
    );
    assert.equal(store.status()[0]?.state, "cancelled");
  } finally {
    store.close();
    await f.cleanup();
  }
});

test(
  "a detached auth adapter surviving helper death cannot recreate a connection after terminal cleanup",
  { timeout: 75_000 },
  async () => {
    const f = await fixture();
    try {
      f.mode("delay_auth");
      const first = await f.start();
      assert.equal((await post(first.url, login)).status, 202);
      await until(
        () =>
          Number(f.receiver.prepare("SELECT count(*) AS n FROM active_adapters").get()?.n) === 1,
      );
      const exited = once(first.child, "exit");
      first.child.kill("SIGKILL");
      await exited;
      f.seal();
      await f.start();
      await until(
        () => Number(f.receiver.prepare("SELECT count(*) AS n FROM terminal").get()?.n) === 1,
        40_000,
      );
      assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM connections").get()?.n, 2);
      assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM active_adapters").get()?.n, 1);
      await until(
        () =>
          f.receiver.prepare("SELECT outcome FROM auth_effects").get()?.outcome ===
          "ignored_after_end",
        15_000,
      );
      assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM connections").get()?.n, 2);
      assert.equal(f.receiver.prepare("SELECT balance FROM finance").get()?.balance, 250000);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "an escaped child holding adapter pipes cannot stall timeout, cleanup or shutdown",
  { timeout: 45_000 },
  async () => {
    const f = await fixture();
    let store: Store | undefined;
    try {
      f.mode("hold_pipe");
      const helper = await f.start();
      store = new Store(f.stateDir, f.config);
      assert.equal((await post(helper.url, login)).status, 202);
      await until(
        () =>
          Number(f.receiver.prepare("SELECT count(*) AS n FROM active_adapters").get()?.n) === 1,
      );
      await until(() => store?.status()[0]?.error === "adapter_failed", 13_000);
      assert.equal(store.status()[0]?.state, "pending");
      assert.equal(store.status()[0]?.attempts, 1);
      const escapedPid = Number(f.receiver.prepare("SELECT pid FROM active_adapters").get()?.pid);
      process.kill(escapedPid, 0);
      f.mode("ok");
      f.seal();
      await until(
        () =>
          store?.status().some((row) => row.kind === "world.ended" && row.state === "done") ??
          false,
      );
      assert.equal(store.status()[0]?.state, "cancelled");
      assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM connections").get()?.n, 2);
      assert.equal(f.receiver.prepare("SELECT balance FROM finance").get()?.balance, 250000);
      process.kill(escapedPid, 0);
      await Promise.race([
        f.stop(helper.child),
        delay(2_000).then(() => {
          throw new Error("shutdown_timeout");
        }),
      ]);
    } finally {
      // Release inherited pipes even when demonstrating the pre-fix deadlock.
      try {
        for (const row of f.receiver.prepare("SELECT pid FROM active_adapters").all()) {
          try {
            process.kill(Number(row.pid), "SIGKILL");
          } catch {
            /* already exited */
          }
        }
      } finally {
        store?.close();
        await f.cleanup();
      }
    }
  },
);

test("two helper processes share one claim, and a mismatched World never reaches an adapter", async () => {
  const f = await fixture();
  try {
    f.seal();
    await Promise.all([f.start(), f.start()]);
    await until(
      () => Number(f.receiver.prepare("SELECT count(*) AS n FROM receipts").get()?.n) === 1,
    );
    assert.equal(f.receiver.prepare("SELECT count(*) AS n FROM connections").get()?.n, 2);
    const store = new Store(f.stateDir, f.config);
    await until(() => store.status()[0]?.state === "done");
    assert.equal(store.status()[0]?.attempts, 1);
    store.close();
  } finally {
    await f.cleanup();
  }
  const wrong = await fixture();
  const store = new Store(wrong.stateDir, wrong.config);
  const worker = new Worker(wrong.config, store, wrong.environment);
  try {
    wrong.wrongWorld();
    await assert.rejects(worker.tick(), /world_scope_mismatch/);
    assert.equal(wrong.receiver.prepare("SELECT count(*) AS n FROM receipts").get()?.n, 0);
  } finally {
    await worker.close();
    store.close();
    await wrong.cleanup();
  }
});
