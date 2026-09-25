import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createHue } from "../src/index.js";
import { createEvaluationClient, TargetOutcomeUncertainError } from "../src/evals.js";
import {
  caseTraceparent,
  createWorldForExecution,
  gatewayState,
  runEnvironmentTarget,
  type SealTiming,
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

/** The World API routes a client needs, with every request recorded. A world finished
 * `completed` stays open for `graceMs`, then for `lagReads` more status reads, as a server whose
 * seal follows its grace. */
function worldApi(
  options: {
    create?: (body: Record<string, unknown>) => Response;
    graceMs?: number;
    lagReads?: number;
    finishConflict?: boolean;
    /** Status reads after the finish that fail with this status before the world answers. */
    failedReads?: { count: number; status: number; retryAfter?: string };
    /** Status reads after the finish never answer. */
    hangReads?: boolean;
  } = {},
) {
  const requests: { method: string; path: string; body?: Record<string, unknown>; at: number }[] =
    [];
  let created: EnvironmentRun | undefined;
  let finished: { status: string; completingUntil: number } | undefined;
  let lagReads = options.lagReads ?? 0;
  const sealed = () =>
    finished !== undefined &&
    (finished.status === "abandoned" ||
      (Date.now() >= finished.completingUntil && lagReads-- <= 0));
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
      requests.push({ method: request.method, path, body, at: Date.now() });
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
      if (path.endsWith("/finish")) {
        finished ??= {
          status: String(body!.status),
          completingUntil: Date.now() + (options.graceMs ?? 200),
        };
        if (options.finishConflict)
          return Response.json({ error: "world_completing" }, { status: 409 });
        const abandoned = finished.status === "abandoned";
        return Response.json({
          id: runId,
          status: body!.status,
          stepCount: 0,
          stateDigest: "a".repeat(64),
          sealedAt: abandoned ? new Date().toISOString() : null,
          lifecycle: abandoned ? "sealed" : "completing",
          completingUntil: abandoned ? null : new Date(finished.completingUntil).toISOString(),
        });
      }
      if (path === `/environment-runs/${runId}` && request.method === "GET") {
        if (finished && options.hangReads) return new Promise<Response>(() => {});
        if (finished && options.failedReads && options.failedReads.count-- > 0)
          return Response.json(
            { error: "unavailable" },
            {
              status: options.failedReads.status,
              headers: { "Retry-After": options.failedReads.retryAfter ?? "0" },
            },
          );
        const done = sealed();
        return Response.json({
          id: runId,
          environmentVersionId: versionId,
          executionId,
          seed: "0",
          status: done ? finished!.status : "open",
          stepCount: 0,
          maxSteps: 500,
          clockNs: "0",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          createdAt: new Date().toISOString(),
          sealedAt: done ? new Date().toISOString() : null,
          stateDigest: "a".repeat(64),
          lifecycle: done ? "sealed" : finished ? "completing" : "live",
          completingUntil:
            finished && !done ? new Date(finished.completingUntil).toISOString() : null,
        });
      }
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

  test("a refusal carries the server diagnostic code; invalid values are dropped", async () => {
    const refusal = async (diagnostic?: string) => {
      const api = worldApi({
        create: () =>
          Response.json(
            { error: "refused" },
            {
              status: 409,
              headers: diagnostic === undefined ? {} : { "x-hue-diagnostic": diagnostic },
            },
          ),
      });
      const client = createEnvironmentClient({ apiKey: key, baseUrl: api.baseUrl });
      return client.createRun({ idempotencyKey: "k", environmentVersionId: versionId }).then(
        () => null,
        (error: unknown) => error as HueEnvironmentError,
      );
    };
    const typed = await refusal("simulation_gateway_required");
    expect(typed).toBeInstanceOf(HueEnvironmentError);
    expect(typed).toMatchObject({ status: 409, diagnostic: "simulation_gateway_required" });
    expect(typed!.message).toBe(
      "Hue environment request failed (HTTP 409, simulation_gateway_required)",
    );
    const boundary = await refusal("a".repeat(64));
    expect(boundary).toMatchObject({ status: 409, diagnostic: "a".repeat(64) });
    for (const hostile of ["Simulation-Gateway", "a b", "x".repeat(65), "<script>"]) {
      const dropped = await refusal(hostile);
      expect(dropped).toMatchObject({ status: 409, diagnostic: undefined });
      expect(dropped!.message).toBe("Hue environment request failed (HTTP 409)");
    }
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      headers: { get: () => "\u0000" },
      body: null,
    })) as unknown as typeof fetch;
    try {
      const client = createEnvironmentClient({ apiKey: key, baseUrl: "https://app.hue.test" });
      await expect(
        client.createRun({ idempotencyKey: "k", environmentVersionId: versionId }),
      ).rejects.toMatchObject({ status: 409, diagnostic: undefined });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(await refusal()).toMatchObject({ status: 409, diagnostic: undefined });
  });
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
    const run = await createWorldForExecution(client, input, { gatewayState: async () => "off" });
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
      createWorldForExecution(once, input, { gatewayState: async () => "on" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(refusing.requests).toHaveLength(2);
    // With the health unknown (unreachable, a timeout), the fields are not dropped on a guess.
    await expect(
      createWorldForExecution(once, input, { gatewayState: async () => "unknown" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(refusing.requests).toHaveLength(3);
  });

  test("the health probe remembers on and off per origin and probes again after an unknown answer", async () => {
    const answers: Array<() => Response> = [];
    const calls: string[] = [];
    const fetchStub = (url: string) => {
      calls.push(url);
      return Promise.resolve().then(answers.shift()!);
    };
    const one = "https://one.hue.test/api/v1";
    // A network failure, then a refusal carrying a diagnostic: neither says the gateway is off.
    answers.push(() => {
      throw new TypeError("fetch failed");
    });
    expect(await gatewayState(one, fetchStub)).toBe("unknown");
    answers.push(
      () =>
        new Response(null, { status: 404, headers: { "x-hue-diagnostic": "host_not_allowed" } }),
    );
    expect(await gatewayState(one, fetchStub)).toBe("unknown");
    // The disabled handler's empty 404 does, and is remembered for the origin.
    answers.push(() => new Response(null, { status: 404 }));
    expect(await gatewayState(one, fetchStub)).toBe("off");
    expect(await gatewayState("https://one.hue.test/elsewhere", fetchStub)).toBe("off");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe("https://one.hue.test/api/sim/gmailmcp.googleapis.com/_hue/health");
    // The gateway's health is on; a health without the gateway marker is not.
    answers.push(() => Response.json({ status: "ok", gateway: "simulation" }));
    expect(await gatewayState("https://two.hue.test", fetchStub)).toBe("on");
    expect(await gatewayState("https://two.hue.test", fetchStub)).toBe("on");
    answers.push(() => Response.json({ status: "ok" }));
    expect(await gatewayState("https://three.hue.test", fetchStub)).toBe("unknown");
    answers.push(() => new Response("busy", { status: 503 }));
    expect(await gatewayState("https://three.hue.test", fetchStub)).toBe("unknown");
    expect(calls).toHaveLength(6);
  });
});

describe("environment target with a gateway world", () => {
  /** One case through `runEnvironmentTarget` against the mock World API. */
  async function runCase(
    api: ReturnType<typeof worldApi>,
    options: { sealTiming?: Partial<SealTiming>; maxAttempts?: number } = {},
  ) {
    const hue = createHue({
      apiKey: key,
      baseUrl: api.baseUrl,
      serviceName: "t",
      captureContent: false,
    });
    const client = createEvaluationClient({ apiKey: key, baseUrl: api.baseUrl });
    const environmentClient = createEnvironmentClient({
      apiKey: key,
      baseUrl: api.baseUrl,
      maxAttempts: options.maxAttempts,
    });
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
          sealTiming: options.sealTiming,
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
            files: [],
            outputDirectory: "/nonexistent/hue-case",
          },
          target: async (_inputs, context) => {
            seen = context;
            return { done: true };
          },
        }),
      );
      return { output, seen: seen!, warnings, returnedAt: Date.now() };
    } finally {
      process.emitWarning = original;
      await hue.shutdown();
    }
  }
  const statusReads = (api: ReturnType<typeof worldApi>) =>
    api.requests.filter(
      (request) => request.method === "GET" && request.path === `/environment-runs/${runId}`,
    ).length;

  test("creates the world with the case context, hands the agent the mirrors and returns only once the world is sealed", async () => {
    const api = worldApi({ graceMs: 300 });
    const { output, seen, warnings, returnedAt } = await runCase(api);
    expect(output).toEqual({ done: true });
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
    expect(seen.world).toMatchObject({ id: runId, token });
    expect(seen.mcp).toEqual({ url: mirror, token, expiresAt: seen.world!.expiresAt });
    expect(seen.tools).toEqual({});
    expect(api.requests.some((request) => request.path.endsWith("/mcp-capability"))).toBe(false);
    expect(warnings).toEqual([]);
    const paths = api.requests.map((request) => request.path);
    const finish = paths.indexOf(`/environment-runs/${runId}/finish`);
    expect(finish).toBeGreaterThan(paths.indexOf("/environment-runs"));
    expect(api.requests[finish]!.body).toEqual({
      idempotencyKey: `execution:${executionId}:completed`,
      status: "completed",
    });
    // Completion refuses an open world, so the target waits out the grace and reads the seal.
    expect(paths.lastIndexOf(`/environment-runs/${runId}`)).toBeGreaterThan(finish);
    expect(statusReads(api)).toBe(1);
    const read = api.requests.at(-1)!;
    expect(read.at - api.requests[finish]!.at).toBeGreaterThanOrEqual(300);
    expect(returnedAt).toBeGreaterThanOrEqual(read.at);
  });

  test("keeps reading the status while the world is still completing after its grace", async () => {
    const api = worldApi({ graceMs: 50, lagReads: 2 });
    const { output } = await runCase(api);
    expect(output).toEqual({ done: true });
    expect(statusReads(api)).toBe(3);
  });

  test("status reads that stay unavailable past the client's retries are polled until the seal", async () => {
    // Four failures exhaust one getRun's attempts; the wait asks again and the fifth read fails
    // once more before the sixth finds the seal.
    const api = worldApi({ graceMs: 50, failedReads: { count: 5, status: 503 } });
    const { output } = await runCase(api);
    expect(output).toEqual({ done: true });
    expect(statusReads(api)).toBe(6);
  });

  test("a 429 that outlasts the client's retries waits its Retry-After, not the poll interval", async () => {
    const api = worldApi({
      graceMs: 50,
      failedReads: { count: 1, status: 429, retryAfter: "1" },
    });
    const { output } = await runCase(api, { maxAttempts: 1, sealTiming: { pollMs: 20 } });
    expect(output).toEqual({ done: true });
    const [refused, sealed] = api.requests.filter(
      (request) => request.method === "GET" && request.path === `/environment-runs/${runId}`,
    );
    expect(sealed!.at - refused!.at).toBeGreaterThanOrEqual(950);
  });

  test("a Retry-After longer than the time left waits only until the deadline", async () => {
    const api = worldApi({
      graceMs: 50,
      failedReads: { count: 100, status: 503, retryAfter: "5" },
    });
    const started = performance.now();
    const failure = await runCase(api, {
      maxAttempts: 1,
      sealTiming: { pollMs: 20, waitMs: 300 },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TargetOutcomeUncertainError);
    expect(performance.now() - started).toBeLessThan(2_000);
    // A timer that fires a moment early may let one more read start before the deadline.
    expect(statusReads(api)).toBeLessThanOrEqual(2);
  });

  test("a world that never seals ends the wait at its deadline as an uncertain outcome", async () => {
    const api = worldApi({ graceMs: 50, lagReads: Number.POSITIVE_INFINITY });
    const started = performance.now();
    const failure = await runCase(api, { sealTiming: { pollMs: 20, waitMs: 300 } }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TargetOutcomeUncertainError);
    expect(((failure as Error).cause as Error).message).toBe(
      `World ${runId} was not sealed after its completion grace`,
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2_000);
    // It kept polling until the deadline rather than giving up after one read.
    expect(statusReads(api)).toBeGreaterThan(3);
  });

  test("a status read that never answers is cut off at the deadline", async () => {
    const api = worldApi({ graceMs: 50, hangReads: true });
    const started = performance.now();
    const failure = await runCase(api, { sealTiming: { waitMs: 300 } }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TargetOutcomeUncertainError);
    expect(((failure as Error).cause as Error).message).toBe(
      `World ${runId} was not sealed after its completion grace`,
    );
    // Without the deadline the read would hold for the client's 10 s request timeout, four times.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(statusReads(api)).toBeLessThanOrEqual(2);
  });

  test("a status read the server refuses outright ends the wait as an uncertain outcome", async () => {
    const api = worldApi({ graceMs: 50, failedReads: { count: 1, status: 404 } });
    await expect(runCase(api)).rejects.toBeInstanceOf(TargetOutcomeUncertainError);
    expect(statusReads(api)).toBe(1);
  });

  test("a finish refused while the world is completing still waits for the seal", async () => {
    const api = worldApi({ graceMs: 100, finishConflict: true });
    const { output } = await runCase(api);
    expect(output).toEqual({ done: true });
    // One read recovers the refused finish; the next, after the grace, finds the seal.
    expect(statusReads(api)).toBe(2);
  });
});
