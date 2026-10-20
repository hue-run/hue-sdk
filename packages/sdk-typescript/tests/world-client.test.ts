import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createEnvironmentClient, HueEnvironmentError } from "../src/environment.js";
import { createWorldClient, HueWorldError, worldHandoff } from "../src/world.js";

test("World registry aliases preserve payloads, pagination and compatibility routing", async () => {
  const worldId = randomUUID();
  const requests: { method: string; path: string; body: unknown }[] = [];
  const identity = { name: "Inbox", slug: "inbox" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        body: request.method === "POST" ? await request.json() : null,
      });
      return Response.json({ id: worldId, ...identity, versions: [] });
    },
  });
  try {
    const connection = { apiKey: "synthetic-world-key", baseUrl: server.url.origin };
    for (const [client, resource] of [
      [createWorldClient(connection), "worlds"],
      [createEnvironmentClient(connection), "environments"],
    ] as const) {
      expect(await client.createWorld(identity)).toEqual(await client.createEnvironment(identity));
      expect(await client.listWorlds({ after: worldId, limit: 20 })).toEqual(
        await client.listEnvironments({ after: worldId, limit: 20 }),
      );
      expect(await client.getWorld(worldId)).toEqual(await client.getEnvironment(worldId));
      expect(requests.splice(0)).toEqual([
        ...Array.from({ length: 2 }, () => ({
          method: "POST",
          path: `/api/v1/${resource}`,
          body: identity,
        })),
        ...Array.from({ length: 2 }, () => ({
          method: "GET",
          path: `/api/v1/${resource}?after=${worldId}&limit=20`,
          body: null,
        })),
        ...Array.from({ length: 2 }, () => ({
          method: "GET",
          path: `/api/v1/${resource}/${worldId}`,
          body: null,
        })),
      ]);
      expect(() => client.getWorld("invalid-id")).toThrow();
      expect(requests).toHaveLength(0);
    }
  } finally {
    server.stop(true);
  }
});

test("World and compatibility clients route independently without changing runtime identity", async () => {
  const instanceId = randomUUID();
  const versionId = randomUUID();
  const routes: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-world-key");
      routes.push(new URL(request.url).pathname);
      if (request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.environmentVersionId).toBe(versionId);
      }
      return Response.json({
        id: instanceId,
        worldId: instanceId,
        environmentVersionId: versionId,
        token: "synthetic-instance-token",
        expiresAt: "2026-10-17T12:00:00.000Z",
        lifecycle: "live",
        env: {},
        surfaces: [],
        mcpConfig: { mcpServers: {} },
        actions: [],
      });
    },
  });
  const connection = { apiKey: "synthetic-world-key", baseUrl: server.url.origin };
  try {
    const world = createWorldClient(connection);
    const legacy = createEnvironmentClient(connection);
    const instance = await world.createInstance({
      idempotencyKey: "world-create",
      worldVersionId: versionId,
    });
    expect(worldHandoff(instance)?.id).toBe(instanceId);
    expect(instance.worldId).toBe(instanceId);
    await world.getInstance(instanceId);
    await legacy.createRun({ idempotencyKey: "legacy-create", environmentVersionId: versionId });
    await legacy.getRun(instanceId);
    expect(routes).toEqual([
      "/api/v1/instances",
      `/api/v1/instances/${instanceId}`,
      "/api/v1/environment-runs",
      `/api/v1/environment-runs/${instanceId}`,
    ]);
    expect(HueWorldError).toBe(HueEnvironmentError);
  } finally {
    server.stop(true);
  }
});

test("World errors retain compatibility catch behavior and omit response content", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("private response content", { status: 403 }),
  });
  try {
    const client = createWorldClient({ apiKey: "synthetic-world-key", baseUrl: server.url.origin });
    await expect(client.getInstance(randomUUID())).rejects.toBeInstanceOf(HueEnvironmentError);
    try {
      await client.getInstance(randomUUID());
    } catch (error) {
      expect(String(error)).not.toContain("private response content");
      expect(String(error)).not.toContain("synthetic-world-key");
    }
  } finally {
    server.stop(true);
  }
});

test("World model operations preserve full identity and retry the same instance request", async () => {
  const modelId = randomUUID();
  const instanceId = randomUUID();
  const identity = "user-" + "a".repeat(300);
  const requests: { path: string; body: unknown }[] = [];
  let starts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      requests.push({ path: url.pathname + url.search, body });
      if (url.pathname.endsWith("/instances") && starts++ === 0)
        return new Response(null, { status: 503, headers: { "Retry-After": "0" } });
      return Response.json({
        worldModel: { id: modelId, entity: { namespace: "user", id: identity } },
        world: { id: randomUUID(), modelId, at: "2026-10-17T00:00:00Z", evidenceCutoff: 7 },
        instance: { id: instanceId, token: "synthetic-instance-token" },
        items: [],
        erased: true,
      });
    },
  });
  try {
    const { WorldModelClient } = await import("../src/world.js");
    const client = new WorldModelClient({
      apiKey: "synthetic-world-key",
      baseUrl: server.url.origin,
    });
    expect(
      (await client.createModel({ entity: { namespace: "user", id: identity } })).worldModel.entity
        .id,
    ).toBe(identity);
    await client.listAccounts(modelId, { after: instanceId, limit: 20 });
    await client.materialize(modelId, { at: "2026-10-17T00:00:00Z" });
    const input = { idempotencyKey: "stable-start", at: "2026-10-17T00:00:00Z" };
    expect((await client.startInstance(modelId, input)).instance.id).toBe(instanceId);
    await client.reproduceInstance(instanceId, { idempotencyKey: "stable-reproduction" });
    await client.eraseModel(modelId);
    expect(requests[1]?.path).toBe(
      `/api/v1/world-models/${modelId}/accounts?after=${instanceId}&limit=20`,
    );
    expect(requests[3]?.body).toEqual(input);
    expect(requests[4]).toEqual(requests[3]);
    expect(requests[5]?.path).toBe(`/api/v1/instances/${instanceId}/reproduce`);
  } finally {
    server.stop(true);
  }
});

test("account-scoped connection tokens survive handoff without inheriting another instance's token", async () => {
  const { agentEnvironment, legacyMcpCapability } = await import("../src/world.js");
  const instance = {
    id: randomUUID(),
    token: "synthetic-unscoped-token",
    expiresAt: "2026-10-17T12:00:00.000Z",
    lifecycle: "live" as const,
    completingUntil: null,
    traceparent: null,
    baggage: "",
    now: null,
    surfaces: [
      {
        provider: "google.gmail",
        surface: "google.gmail/mcp",
        providerInstanceKey: "work",
        url: "https://app.hue.test/mcp",
        alias: null,
        token: "synthetic-work-token",
      },
    ],
    env: { HUE_SIM_ACCOUNT_WORK_MCP_TOKEN: "synthetic-work-token" },
    mcpConfig: {
      mcpServers: {
        work: {
          type: "http" as const,
          url: "https://app.hue.test/mcp",
          headers: { Authorization: "Bearer synthetic-work-token" },
        },
      },
    },
  };
  expect(legacyMcpCapability(instance)?.token).toBe("synthetic-work-token");
  const child = agentEnvironment(instance, {
    parent: { HUE_SIM_ACCOUNT_PERSONAL_MCP_TOKEN: "stale-personal-token" },
  });
  expect(child.HUE_SIM_ACCOUNT_WORK_MCP_TOKEN).toBe("synthetic-work-token");
  expect(child.HUE_SIM_ACCOUNT_PERSONAL_MCP_TOKEN).toBeUndefined();
  expect(child.HUE_MCP_TOKEN).toBe("synthetic-work-token");
});

test("canonical authored Worlds accept arbitrary apps and independent accounts for one app", async () => {
  const { createWorldClient } = await import("../src/world.js");
  const worldId = randomUUID();
  const definition: import("../src/world.js").WorldDefinitionV2 = {
    schemaVersion: 2,
    state: { collections: { work: {}, personal: {}, documents: {} } },
    actions: [],
    providerInstances: [
      {
        providerId: "google.gmail",
        providerInstanceKey: "work",
        syntheticPrincipalId: randomUUID(),
        configuration: { kind: "gmail_mailbox/v2", collection: "work" },
      },
      {
        providerId: "google.gmail",
        providerInstanceKey: "personal",
        syntheticPrincipalId: randomUUID(),
        configuration: { kind: "gmail_mailbox/v2", collection: "personal" },
      },
      {
        providerId: "example.documents",
        providerInstanceKey: "team-docs",
        syntheticPrincipalId: randomUUID(),
        configuration: { kind: "documents/v1", collection: "documents", workspace: { id: "team" } },
        dialects: ["example.documents/mcp"],
      },
    ],
  };
  definition.providerInstances.push(
    ...Array.from({ length: 20 }, (_, index) => ({
      providerId: "example.documents",
      providerInstanceKey: `extra-${index}`,
      syntheticPrincipalId: randomUUID(),
      configuration: { kind: "documents/v1", collection: "documents" },
    })),
  );
  definition.credentialFailures = definition.providerInstances.map((binding) => ({
    provider: binding.providerId,
    surface: "example.documents/rest",
    operation: "read",
    instance: binding.providerInstanceKey,
  }));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe(`/api/v1/worlds/${worldId}/versions`);
      expect(await request.json()).toEqual({ definition });
      return Response.json({ id: randomUUID(), version: 1 });
    },
  });
  try {
    const client = createWorldClient({ apiKey: "synthetic-world-key", baseUrl: server.url.origin });
    expect((await client.publishVersion(worldId, definition)).version).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("model cursors remain opaque and cannot add query parameters", async () => {
  const { WorldModelClient } = await import("../src/world.js");
  const cursor = "c1.opaque+cursor&limit=999";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      expect(url.searchParams.get("after")).toBe(cursor);
      expect(url.searchParams.get("limit")).toBe("20");
      expect([...url.searchParams.keys()]).toEqual(["after", "limit"]);
      return Response.json({ items: [] });
    },
  });
  try {
    const client = new WorldModelClient({
      apiKey: "synthetic-world-key",
      baseUrl: server.url.origin,
    });
    expect((await client.listModels({ after: cursor, limit: 20 })).items).toEqual([]);
  } finally {
    server.stop(true);
  }
});
