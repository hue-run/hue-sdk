import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createHue } from "../src/index.js";
import { createEvaluationClient } from "../src/evals.js";
import {
  caseTraceparent,
  createWorldForExecution,
  runEnvironmentTarget,
} from "../src/evals/environment-target.js";
import {
  agentEnvironment,
  createEnvironmentClient,
  HueEnvironmentError,
  isHueControlPlaneCredential,
  legacyMcpCapability,
  stripHueControlPlaneCredentials,
  worldHandoff,
  writeMcpConfig,
  type EnvironmentRun,
  type WorldHandoff,
} from "../src/environment.js";

const key = `hue_sk_test_${"k".repeat(12)}_${"s".repeat(43)}`;
const runId = randomUUID();
const versionId = randomUUID();
const executionId = randomUUID();
const token = `hue_world_${"c".repeat(64)}.${"s".repeat(43)}`;
const mirror = "https://app.hue.test/api/sim/gmailmcp.googleapis.com/mcp/v1";
const rest = "https://app.hue.test/api/sim/gmail.googleapis.com/gmail/v1";

/** A create response for a world the gateway serves (docs/environment-contract.md#create). */
function gatewayRun(overrides: Partial<EnvironmentRun> = {}): EnvironmentRun {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  return {
    id: runId,
    environmentVersionId: versionId,
    clockNs: "0",
    stateDigest: "a".repeat(64),
    maxSteps: 500,
    expiresAt,
    actions: [],
    worldId: runId,
    token,
    lifecycle: "live",
    completingUntil: null,
    baggage: `hue-world=${runId}`,
    traceparent: null,
    surfaces: [
      {
        provider: "google.gmail",
        surface: "google.gmail/mcp",
        providerInstanceKey: "gmail-primary",
        url: mirror,
        alias: null,
      },
      {
        provider: "google.gmail",
        surface: "google.gmail/rest",
        providerInstanceKey: "gmail-primary",
        url: rest,
        alias: null,
      },
    ],
    env: {
      HUE_WORLD_ID: runId,
      HUE_WORLD_TOKEN: token,
      BAGGAGE: `hue-world=${runId}`,
      HUE_SIM_GOOGLE_GMAIL_MCP_URL: mirror,
      HUE_SIM_GOOGLE_GMAIL_REST_URL: rest,
    },
    mcpConfig: {
      mcpServers: {
        "gmail-primary": {
          type: "http",
          url: mirror,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    connection: null,
    ...overrides,
  };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

/** The World API routes a client needs, with every request recorded. */
function worldApi(options: { create?: (body: Record<string, unknown>) => Response } = {}) {
  const requests: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let created: EnvironmentRun | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v1", "") + url.search;
      if (url.pathname.startsWith("/api/v1/otlp/")) {
        await request.arrayBuffer();
        return new Response(new Uint8Array(), {
          headers: { "Content-Type": "application/x-protobuf" },
        });
      }
      const body =
        request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : undefined;
      requests.push({ method: request.method, path, body });
      if (path === "/projects/current")
        return Response.json({
          id: randomUUID(),
          name: "p",
          slug: "p",
          organizationId: randomUUID(),
        });
      if (path === "/environment-runs" && request.method === "POST") {
        if (options.create) return options.create(body!);
        created ??= gatewayRun({ traceparent: (body!.traceparent as string) ?? null });
        return Response.json(created, { status: 201 });
      }
      if (path.endsWith("/finish"))
        return Response.json({
          id: runId,
          status: body!.status,
          stepCount: 0,
          stateDigest: "a".repeat(64),
          sealedAt: null,
          lifecycle: "completing",
          completingUntil: new Date(Date.now() + 5_000).toISOString(),
        });
      if (path.includes("/evidence"))
        return Response.json({ worldId: runId, section: path.split("section=")[1] ?? "all" });
      if (path.endsWith("/mcp-capability"))
        return Response.json({ url: "https://legacy", token: "hue_sim_x", expiresAt: "later" });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  servers.push(server);
  return { server, requests, baseUrl: server.url.origin };
}

describe("world handoff helpers", () => {
  test("a gateway response becomes a handoff; a legacy response does not", () => {
    const world = worldHandoff(gatewayRun());
    expect(world).toMatchObject({ id: runId, token, lifecycle: "live", surfaces: [{}, {}] });
    expect(world!.env.HUE_SIM_GOOGLE_GMAIL_MCP_URL).toBe(mirror);
    const legacy = gatewayRun();
    delete legacy.token;
    delete legacy.env;
    delete legacy.mcpConfig;
    delete legacy.surfaces;
    expect(worldHandoff(legacy)).toBeNull();
    // The handoff is a copy: mutating it never reaches the response.
    world!.mcpConfig.mcpServers["gmail-primary"]!.headers.Authorization = "changed";
    expect(gatewayRun().mcpConfig!.mcpServers["gmail-primary"]!.headers.Authorization).toBe(
      `Bearer ${token}`,
    );
  });

  test("the agent environment drops Hue control-plane credentials unless opted in", () => {
    const world = worldHandoff(gatewayRun())!;
    const parent = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "customer-model-key",
      HUE_API_KEY: key,
      HUE_MCP_KEY: "hue_mcp_project",
      ANOTHER_KEY: `hue_sk_live_${"a".repeat(12)}_secret`,
      GRANT: `hue_attempt_${"a".repeat(20)}.${"b".repeat(43)}`,
      HUE_BASE_URL: "https://app.hue.test",
      EMPTY: undefined,
    };
    const child = agentEnvironment(world, { parent });
    expect(child).not.toHaveProperty("HUE_API_KEY");
    expect(child).not.toHaveProperty("HUE_MCP_KEY");
    expect(child).not.toHaveProperty("ANOTHER_KEY");
    expect(child).not.toHaveProperty("GRANT");
    expect(child).not.toHaveProperty("EMPTY");
    expect(child).toMatchObject({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "customer-model-key",
      HUE_BASE_URL: "https://app.hue.test",
      HUE_WORLD_ID: runId,
      HUE_WORLD_TOKEN: token,
      HUE_SIM_GOOGLE_GMAIL_MCP_URL: mirror,
      // The compatibility names of the retired bridge point at the first MCP mirror.
      HUE_MCP_URL: mirror,
      HUE_MCP_TOKEN: token,
      HUE_MCP_EXPIRES_AT: world.expiresAt,
    });
    const opted = agentEnvironment(world, { parent, includeHueCredentials: true });
    expect(opted.HUE_API_KEY).toBe(key);
    const canonical = agentEnvironment(world, { parent, legacyMcpVariables: false });
    expect(canonical).not.toHaveProperty("HUE_MCP_URL");
    // A parent variable never overrides a world carrier.
    expect(agentEnvironment(world, { parent: { HUE_WORLD_TOKEN: "stale" } }).HUE_WORLD_TOKEN).toBe(
      token,
    );
    expect(isHueControlPlaneCredential("X", "hue_sk_test_abc_def")).toBe(true);
    expect(isHueControlPlaneCredential("X", "sk-live-not-hue")).toBe(false);
    expect(stripHueControlPlaneCredentials(parent)).toEqual({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "customer-model-key",
      HUE_BASE_URL: "https://app.hue.test",
    });
  });

  test("the legacy projection uses the first MCP mirror and is absent without one", () => {
    const world = worldHandoff(gatewayRun())!;
    expect(legacyMcpCapability(world)).toEqual({ url: mirror, token, expiresAt: world.expiresAt });
    const restOnly: WorldHandoff = { ...world, mcpConfig: { mcpServers: {} } };
    expect(legacyMcpCapability(restOnly)).toBeUndefined();
  });

  test("the MCP configuration file is owner-only and removed on dispose", async () => {
    const world = worldHandoff(gatewayRun())!;
    const file = await writeMcpConfig(world);
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(file.path))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file.path, "utf8"))).toEqual(world.mcpConfig);
    await file.dispose();
    await expect(stat(dirname(file.path))).rejects.toThrow();
    await file.dispose();
  });
});

describe("environment client World API", () => {
  test("create forwards the trace context and agent revision and validates their shape", async () => {
    const api = worldApi();
    const client = createEnvironmentClient({ apiKey: key, baseUrl: api.baseUrl });
    const traceparent = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
    const run = await client.createRun({
      idempotencyKey: `execution:${executionId}`,
      environmentVersionId: versionId,
      executionId,
      ttlSeconds: 600,
      traceparent,
      agentRevision: "agent@1.2.3",
    });
    expect(api.requests[0]!.body).toMatchObject({
      idempotencyKey: `execution:${executionId}`,
      executionId,
      ttlSeconds: 600,
      traceparent,
      agentRevision: "agent@1.2.3",
    });
    expect(run.token).toBe(token);
    expect(run.traceparent).toBe(traceparent);
    for (const traceparent of [
      "01-bad",
      `00-${"0".repeat(32)}-${"2".repeat(16)}-01`,
      `00-${"1".repeat(32)}-${"0".repeat(16)}-01`,
    ])
      expect(() =>
        client.createRun({ idempotencyKey: "k", environmentVersionId: versionId, traceparent }),
      ).toThrow(TypeError);
    expect(() =>
      client.createRun({
        idempotencyKey: "k",
        environmentVersionId: versionId,
        agentRevision: "x".repeat(257),
      }),
    ).toThrow(RangeError);
    expect(api.requests).toHaveLength(1);
  });

  test("evidence is read with its section and body options", async () => {
    const api = worldApi();
    const client = createEnvironmentClient({ apiKey: key, baseUrl: api.baseUrl });
    expect(await client.getEvidence(runId)).toEqual({ worldId: runId, section: "all" });
    expect(await client.getEvidence(runId, { section: "ledger", bodies: false })).toEqual({
      worldId: runId,
      section: "ledger&bodies=false",
    });
    expect(api.requests.map((request) => request.path)).toEqual([
      `/environment-runs/${runId}/evidence`,
      `/environment-runs/${runId}/evidence?section=ledger&bodies=false`,
    ]);
    expect(() => client.getEvidence(runId, { section: "bodies" as "all" })).toThrow(TypeError);
  });

  test("a 429 with Retry-After waits that long instead of backing off", async () => {
    let refusals = 2;
    const started = Date.now();
    const api = worldApi({
      create: () =>
        refusals-- > 0
          ? Response.json(
              { error: "rate_limited" },
              { status: 429, headers: { "retry-after": "1", "x-hue-diagnostic": "rate_limited" } },
            )
          : Response.json(gatewayRun(), { status: 201 }),
    });
    const client = createEnvironmentClient({ apiKey: key, baseUrl: api.baseUrl, maxAttempts: 3 });
    const run = await client.createRun({ idempotencyKey: "k", environmentVersionId: versionId });
    expect(run.token).toBe(token);
    expect(api.requests).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    // A decided refusal still is not retried, and the error carries the wait it was given.
    const refused = worldApi({
      create: () => Response.json({ error: "x" }, { status: 409 }),
    });
    const once = createEnvironmentClient({ apiKey: key, baseUrl: refused.baseUrl });
    await expect(
      once.createRun({ idempotencyKey: "k", environmentVersionId: versionId }),
    ).rejects.toMatchObject({ status: 409 });
    expect(refused.requests).toHaveLength(1);
    const wait = new HueEnvironmentError(503, 1000);
    expect(wait.retryAfterMs).toBe(1000);
  }, 10_000);
});

describe("case trace context", () => {
  test("carries the span's own flags, so an unsampled case span is not reported as sampled", () => {
    const ids = { traceId: "1".repeat(32), spanId: "2".repeat(16) };
    expect(caseTraceparent(ids)).toBe(`00-${ids.traceId}-${ids.spanId}-01`);
    expect(caseTraceparent({ ...ids, span: { spanContext: () => ({ traceFlags: 0 }) } })).toBe(
      `00-${ids.traceId}-${ids.spanId}-00`,
    );
    expect(caseTraceparent({ ...ids, span: { spanContext: () => ({ traceFlags: 1 }) } })).toBe(
      `00-${ids.traceId}-${ids.spanId}-01`,
    );
  });
});

describe("world creation on a deployment whose gateway is off", () => {
  test("repeats the create once without the World API fields when the legacy create refuses them", async () => {
    const bodies: Record<string, unknown>[] = [];
    const legacy = gatewayRun();
    delete legacy.token;
    delete legacy.env;
    delete legacy.mcpConfig;
    delete legacy.surfaces;
    const api = worldApi({
      create: (body) => {
        bodies.push(body);
        return "traceparent" in body || "agentRevision" in body
          ? Response.json({ error: "Invalid request" }, { status: 400 })
          : Response.json(legacy, { status: 201 });
      },
    });
    const client = createEnvironmentClient({ apiKey: key, baseUrl: api.baseUrl });
    const input = {
      idempotencyKey: `execution:${executionId}`,
      environmentVersionId: versionId,
      executionId,
      traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
      agentRevision: "agent@1",
    };
    // The deployment's health says the gateway is off, so the refusal is the legacy body's.
    const run = await createWorldForExecution(client, input, { gatewayEnabled: async () => false });
    expect(run.token).toBeUndefined();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ traceparent: input.traceparent, agentRevision: "agent@1" });
    expect(bodies[1]).not.toHaveProperty("traceparent");
    expect(bodies[1]).not.toHaveProperty("agentRevision");
    const refusing = worldApi({
      create: () => Response.json({ error: "Invalid request" }, { status: 400 }),
    });
    const once = createEnvironmentClient({ apiKey: key, baseUrl: refusing.baseUrl });
    await expect(
      createWorldForExecution(once, { idempotencyKey: "k", environmentVersionId: versionId }),
    ).rejects.toMatchObject({ status: 400 });
    expect(refusing.requests).toHaveLength(1);
    // With the gateway on, a 400 (a trace context that does not match the execution) stands.
    await expect(
      createWorldForExecution(once, input, { gatewayEnabled: async () => true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(refusing.requests).toHaveLength(2);
  });
});

describe("environment target with a gateway world", () => {
  test("creates the world with the case context, hands the agent the mirrors and finishes before returning", async () => {
    const api = worldApi();
    const hue = createHue({
      apiKey: key,
      baseUrl: api.baseUrl,
      serviceName: "t",
      captureContent: false,
    });
    const client = createEvaluationClient({ apiKey: key, baseUrl: api.baseUrl });
    const environmentClient = createEnvironmentClient({ apiKey: key, baseUrl: api.baseUrl });
    const warnings: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((message: string | Error) => {
      warnings.push(String(message));
    }) as typeof process.emitWarning;
    let seen: Parameters<Parameters<typeof runEnvironmentTarget>[0]["target"]>[1] | undefined;
    try {
      const output = await hue.withSpan("hue.experiment.case", (span) =>
        runEnvironmentTarget({
          client,
          environmentClient,
          hue,
          inputs: { task: "reply" },
          agentRevision: "tester@abc123",
          ttlSeconds: 600,
          context: {
            config: {},
            item: {
              id: randomUUID(),
              externalKey: "reply",
              datasetVersionId: versionId,
              inputs: { task: "reply" },
              hasExpected: false,
              metadata: {},
              environmentVersionId: versionId,
              createdAt: new Date().toISOString(),
            } as never,
            executionId,
            span,
          },
          target: async (_inputs, context) => {
            seen = context;
            return { done: true };
          },
        }),
      );
      expect(output).toEqual({ done: true });
    } finally {
      process.emitWarning = original;
      await hue.shutdown();
    }
    const create = api.requests.find((request) => request.path === "/environment-runs")!;
    expect(create.body).toMatchObject({
      idempotencyKey: `execution:${executionId}`,
      executionId,
      ttlSeconds: 600,
      agentRevision: "tester@abc123",
    });
    expect(create.body!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    // The agent got the world and its first MCP mirror as `mcp`; no legacy capability was minted
    // and no Hue-native tools were bound for a gateway world.
    expect(seen!.world).toMatchObject({ id: runId, token });
    expect(seen!.mcp).toEqual({ url: mirror, token, expiresAt: seen!.world!.expiresAt });
    expect(seen!.tools).toEqual({});
    expect(api.requests.some((request) => request.path.endsWith("/mcp-capability"))).toBe(false);
    expect(warnings).toEqual([]);
    const paths = api.requests.map((request) => request.path);
    expect(paths.indexOf(`/environment-runs/${runId}/finish`)).toBeGreaterThan(
      paths.indexOf("/environment-runs"),
    );
    expect(api.requests.find((request) => request.path.endsWith("/finish"))!.body).toEqual({
      idempotencyKey: `execution:${executionId}:completed`,
      status: "completed",
    });
  });
});
