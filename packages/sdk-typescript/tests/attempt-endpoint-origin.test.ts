import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHue } from "../src/client.js";
import { createEnvironmentClient } from "../src/environment.js";
import {
  actualAgentManifestV2,
  agentManifestDigestV2,
  createEvaluationClient,
  dependencyManifestV2,
  dependencyProviderV2,
  executionManifestDigestV2,
  prepareAttemptInputV2,
  type AttemptConnectionBundleV2,
} from "../src/evals.js";
import { runEnvironmentTarget } from "../src/evals/environment-target.js";
import type { HueSpan } from "../src/types.js";

/**
 * The attempt bearer below is an obvious placeholder, not a credential.
 * Hostile endpoints are loopback or names the agent must not resolve.
 */

const MCP_BEARER = "placeholder-mcp-bearer-000000000000000000";
const REST_BEARER = "placeholder-rest-bearer-00000000000000000";
const API_KEY = "synthetic-project-key";

function canonicalDigest(value: unknown): string {
  function canonical(input: unknown): string {
    if (input === null || typeof input === "string" || typeof input === "boolean")
      return JSON.stringify(input);
    if (typeof input === "number" && Number.isSafeInteger(input)) return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (typeof input === "object" && input !== null)
      return `{${Object.keys(input)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    throw new TypeError("Fixture digest input must be JSON");
  }
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

const digest = (label: string) => canonicalDigest({ fixture: label });
const componentKeys = ["agent", "prompt", "model", "tools", "approvals", "orchestration"] as const;

function manifestFixture(surfaces: Array<"google.gmail/mcp" | "google.gmail/rest">) {
  const catalogDigest = digest("gmail-catalog");
  const helperConfigurationDigest = digest("gmail-helper");
  const mcpContract = digest("mcp-contract");
  const restContract = digest("rest-contract");
  const includeMcp = surfaces.includes("google.gmail/mcp");
  const includeRest = surfaces.includes("google.gmail/rest");
  const actualManifest = actualAgentManifestV2.parse({
    schemaVersion: 2,
    components: Object.fromEntries(
      componentKeys.map((key) => [key, { digest: digest(key), evidence: "observed" }]),
    ),
    catalogs: includeMcp
      ? [
          {
            providerInstanceKey: "gmail-primary",
            surfaceKey: "google.gmail/mcp",
            digest: catalogDigest,
            evidence: "observed",
          },
        ]
      : [],
    helperConfigurations: includeRest
      ? [
          {
            providerInstanceKey: "gmail-primary",
            surfaceKey: "google.gmail/rest",
            digest: helperConfigurationDigest,
            evidence: "observed",
          },
        ]
      : [],
  });
  const provider = dependencyProviderV2.parse({
    providerInstanceKey: "gmail-primary",
    providerId: "google.gmail",
    syntheticPrincipalId: randomUUID(),
    scopes: ["mail.read"],
    profile: {
      profileId: "test.gmail.v2",
      profileDigest: digest("profile"),
      buildDigest: digest("build"),
      coverageDigest: digest("coverage"),
      contractDigests: [
        ...(includeMcp ? [{ surfaceKey: "google.gmail/mcp", contractDigest: mcpContract }] : []),
        ...(includeRest ? [{ surfaceKey: "google.gmail/rest", contractDigest: restContract }] : []),
      ],
    },
    workflowDigest: digest("workflow"),
    surfaces: [
      ...(includeRest
        ? [
            {
              surfaceRegistrationId: "test.gmail.rest.v2",
              surfaceKey: "google.gmail/rest" as const,
              protocolVersion: "v1",
              contractDigest: restContract,
              catalogDigest: null,
              helperConfigurationDigest,
              runtimeRegistrationDigest: digest("rest-registration"),
            },
          ]
        : []),
      ...(includeMcp
        ? [
            {
              surfaceRegistrationId: "test.gmail.mcp.v2",
              surfaceKey: "google.gmail/mcp" as const,
              protocolVersion: "2025-06-18",
              contractDigest: mcpContract,
              catalogDigest,
              helperConfigurationDigest: null,
              runtimeRegistrationDigest: digest("mcp-registration"),
            },
          ]
        : []),
    ],
  });
  const dependencyManifest = dependencyManifestV2.parse({
    schemaVersion: 2,
    providers: [provider],
  });
  return { actualManifest, dependencyManifest };
}

function wireBundle(
  fixture: ReturnType<typeof manifestFixture>,
  identity: {
    bindingId: string;
    executionId: string;
    environmentRunId: string;
    generation: number;
    expectedAgentManifestId: string;
  },
  endpoints: Record<string, string>,
): AttemptConnectionBundleV2 {
  const actualAgentManifestDigest = agentManifestDigestV2(fixture.actualManifest);
  return {
    schemaVersion: 2,
    bindingId: identity.bindingId,
    executionId: identity.executionId,
    environmentRunId: identity.environmentRunId,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    credentialGeneration: identity.generation,
    providers: fixture.dependencyManifest.providers.map((provider) => ({
      ...provider,
      surfaces: provider.surfaces.map((surface) => ({
        ...surface,
        endpoint: endpoints[surface.surfaceKey] ?? "https://127.0.0.1/missing",
        bearer: surface.surfaceKey.endsWith("/mcp") ? MCP_BEARER : REST_BEARER,
      })),
    })),
    parity: {
      expectedAgentManifestId: identity.expectedAgentManifestId,
      expectedAgentManifestDigest: actualAgentManifestDigest,
      actualAgentManifestDigest,
      actualManifest: fixture.actualManifest,
      dependencyManifestDigest: canonicalDigest(fixture.dependencyManifest),
      executionManifestDigest: executionManifestDigestV2(
        fixture.actualManifest,
        fixture.dependencyManifest,
        {
          bindingId: identity.bindingId,
          executionId: identity.executionId,
          environmentRunId: identity.environmentRunId,
        },
      ),
      evidenceSource: "caller_supplied",
    },
  };
}

const readyReport = {
  schemaVersion: 2 as const,
  status: "ready" as const,
  evidenceSource: "caller_supplied" as const,
  findings: [],
};

function originOf(baseUrl: string): { hostname: string; port: string } {
  const url = new URL(baseUrl);
  return {
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? "443" : "80"),
  };
}

/** Where a second parse of the endpoint actually connects, which is the use. */
function connectTarget(value: string): { hostname: string; port: string; path: string } {
  const url = new URL(value);
  return {
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? "443" : "80"),
    path: url.pathname,
  };
}

describe("V2 attempt endpoints stay on the Hue origin", () => {
  test("an https endpoint on the Hue origin host and port is what the agent receives", async () => {
    const observed = await drive({ surfaces: ["google.gmail/mcp"], endpointFor: sameOrigin });
    expect(observed.invoked).toBe(true);
    expect(observed.steered).toBe(false);
    expect(observed.attackerPresented).toBe(0);
    expect(observed.marker).toBe(true);
    const received = connectTarget(observed.mcpUrl ?? "");
    expect({ hostname: received.hostname, port: received.port }).toEqual(
      originOf(observed.hueOrigin),
    );
  });

  test("a normalized address literal on another port is not where the bearer is presented", async () => {
    const observed = await drive({
      surfaces: ["google.gmail/mcp"],
      endpointFor: (_origin, attacker) => `https://127.1:${attacker.port}/mcp`,
    });
    expect(observed).toMatchObject({
      invoked: false,
      steered: false,
      attackerPresented: 0,
      marker: false,
    });
  });

  test("a public host in the prepare-attempt body never reaches the agent", async () => {
    const observed = await drive({
      surfaces: ["google.gmail/mcp"],
      endpointFor: () => "https://attacker.example/mcp",
    });
    expect(observed).toMatchObject({
      invoked: false,
      steered: false,
      attackerPresented: 0,
      marker: false,
    });
  });

  test("prepare-attempt refuses every endpoint that is not the Hue origin", async () => {
    const session = await openHue(["google.gmail/mcp", "google.gmail/rest"]);
    const fixture = session.fixture;
    session.endpoints = {
      "google.gmail/mcp": sameOrigin(session.hueOrigin, session.attacker),
      "google.gmail/rest": sameOrigin(session.hueOrigin, session.attacker),
    };
    const allowed = prepareAttemptInputV2.parse({
      schemaVersion: 2,
      idempotencyKey: randomUUID(),
      executionId: randomUUID(),
      environmentRunId: randomUUID(),
      expectedAgentManifestDigest: agentManifestDigestV2(fixture.actualManifest),
      actualManifest: fixture.actualManifest,
      requestedProviders: [
        {
          providerInstanceKey: "gmail-primary",
          surfaceKeys: ["google.gmail/rest", "google.gmail/mcp"],
        },
      ],
    });
    const hostile = [
      "https://attacker.example/mcp",
      "https://127.0.0.1%2eattacker.example/mcp",
      "https://[::1]/mcp",
      "https://localhost/mcp",
      `https://127.0.0.1:${session.attacker.port}/mcp`,
      `https://0x7f000001:${session.attacker.port}/mcp`,
      `https://127.1:${session.attacker.port}/mcp`,
    ];
    try {
      const prepared = await session.client.prepareAttempt(allowed);
      expect(prepared.status).toBe("ready");
      for (const endpoint of hostile) {
        session.endpoints = {
          "google.gmail/mcp": endpoint,
          "google.gmail/rest": endpoint,
        };
        const executionId = randomUUID();
        const environmentRunId = randomUUID();
        const request = prepareAttemptInputV2.parse({
          schemaVersion: 2,
          idempotencyKey: randomUUID(),
          executionId,
          environmentRunId,
          expectedAgentManifestDigest: agentManifestDigestV2(fixture.actualManifest),
          actualManifest: fixture.actualManifest,
          requestedProviders: [
            {
              providerInstanceKey: "gmail-primary",
              surfaceKeys: ["google.gmail/rest", "google.gmail/mcp"],
            },
          ],
        });
        await expect(session.client.prepareAttempt(request)).rejects.toThrow();
      }
      expect(session.attacker.presented).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("refresh refuses an endpoint moved off the Hue origin", async () => {
    const session = await openHue();
    const fixture = session.fixture;
    const allowed = sameOrigin(session.hueOrigin, session.attacker);
    session.endpoints = { "google.gmail/mcp": allowed };
    const executionId = randomUUID();
    const environmentRunId = randomUUID();
    const request = prepareAttemptInputV2.parse({
      schemaVersion: 2,
      idempotencyKey: randomUUID(),
      executionId,
      environmentRunId,
      expectedAgentManifestDigest: agentManifestDigestV2(fixture.actualManifest),
      actualManifest: fixture.actualManifest,
      requestedProviders: [
        { providerInstanceKey: "gmail-primary", surfaceKeys: ["google.gmail/mcp"] },
      ],
    });
    try {
      const prepared = await session.client.prepareAttempt(request);
      if (prepared.status !== "ready") throw new Error("Same-origin prepare was refused");
      session.endpoints = {
        "google.gmail/mcp": `https://127.1:${session.attacker.port}/mcp`,
      };
      session.generationBump = 1;
      await expect(
        session.client.refreshAttemptConnection(prepared.bundle, {
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
      expect(session.attacker.presented).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("a native surface on another host is not handed to the agent beside a same-origin MCP url", async () => {
    const observed = await drive({
      surfaces: ["google.gmail/rest", "google.gmail/mcp"],
      endpointFor: (origin, attacker, surface) =>
        surface.endsWith("/mcp")
          ? sameOrigin(origin, attacker)
          : `https://127.1:${attacker.port}/native`,
    });
    expect(observed).toMatchObject({
      invoked: false,
      steered: false,
      attackerPresented: 0,
      marker: false,
    });
  });
});

function sameOrigin(hueOrigin: string, _attacker: { port: number }): string {
  const hue = new URL(hueOrigin);
  return `https://${hue.hostname}:${hue.port}/mcp`;
}

interface AttackServer {
  port: number;
  presented: number;
  close(): Promise<void>;
}

async function listenAttacker(): Promise<AttackServer> {
  const directory = await mkdtemp(join(tmpdir(), "hue-attempt-origin-cert-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const state = { presented: 0 };
  const server: Server = createServer({ key, cert }, (incoming, response) => {
    const authorization = incoming.headers.authorization;
    if (typeof authorization === "string" && authorization.startsWith("Bearer "))
      state.presented += 1;
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Attacker listener has no port");
  return {
    get presented() {
      return state.presented;
    },
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }).finally(() => rm(directory, { recursive: true, force: true })),
  };
}

interface HueSession {
  hueOrigin: string;
  attacker: AttackServer;
  client: ReturnType<typeof createEvaluationClient>;
  endpoints: Record<string, string>;
  generationBump: number;
  fixture: ReturnType<typeof manifestFixture>;
  close(): Promise<void>;
}

async function openHue(
  surfaces: Array<"google.gmail/mcp" | "google.gmail/rest"> = ["google.gmail/mcp"],
): Promise<HueSession> {
  const attacker = await listenAttacker();
  const fixture = manifestFixture(surfaces);
  const session: HueSession = {
    hueOrigin: "",
    attacker,
    client: undefined as unknown as HueSession["client"],
    endpoints: {},
    generationBump: 0,
    fixture,
    async close() {
      await attacker.close();
      await new Promise<void>((resolve) => hueServer.stop(true).then(() => resolve(), resolve));
    },
  };
  let bindingId = randomUUID();
  let expectedAgentManifestId = randomUUID();
  const worlds = new Map<string, string>();
  const hueServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body =
        request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      if (request.method === "POST" && url.pathname === "/api/v1/environment-runs") {
        const id = randomUUID();
        worlds.set(id, "open");
        return Response.json({
          id,
          environmentVersionId: String(body.environmentVersionId),
          clockNs: "0",
          stateDigest: "a".repeat(64),
          maxSteps: 50,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          actions: [],
        });
      }
      const world = /^\/api\/v1\/environment-runs\/([^/]+)(?:\/finish)?$/.exec(url.pathname);
      if (world) {
        const id = world[1]!;
        if (url.pathname.endsWith("/finish")) worlds.set(id, String(body.status));
        return Response.json({
          id,
          environmentVersionId: randomUUID(),
          executionId: randomUUID(),
          seed: "e".repeat(32),
          status: worlds.get(id) ?? "open",
          stepCount: 0,
          maxSteps: 50,
          clockNs: "0",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          createdAt: new Date().toISOString(),
          sealedAt: worlds.get(id) === "open" ? null : new Date().toISOString(),
          stateDigest: "a".repeat(64),
          validity: "not_assessed",
          coverageGap: null,
        });
      }
      const prepare = /^\/api\/v1\/experiment-executions\/([^/]+)\/prepare-attempt$/.exec(
        url.pathname,
      );
      const refresh = /^\/api\/v1\/attempt-bindings\/([^/]+)\/refresh$/.exec(url.pathname);
      if (prepare || refresh) {
        if (prepare) {
          bindingId = randomUUID();
          expectedAgentManifestId = randomUUID();
        }
        const executionId = prepare ? prepare[1]! : lastIdentity.executionId;
        const environmentRunId = prepare
          ? String((body as { environmentRunId: string }).environmentRunId)
          : lastIdentity.environmentRunId;
        const generation = prepare ? 0 : lastIdentity.generation + session.generationBump;
        lastIdentity = {
          bindingId,
          executionId,
          environmentRunId,
          generation,
          expectedAgentManifestId,
        };
        const bundle = wireBundle(session.fixture, lastIdentity, session.endpoints);
        return Response.json({ status: "ready", preflightReport: readyReport, bundle });
      }
      return new Response(null, { status: 404 });
    },
  });
  // lastIdentity is assigned before refresh; prepare always runs first in these tests.
  let lastIdentity = {
    bindingId,
    executionId: randomUUID(),
    environmentRunId: randomUUID(),
    generation: 0,
    expectedAgentManifestId,
  };
  session.hueOrigin = hueServer.url.origin;
  session.client = createEvaluationClient({
    apiKey: API_KEY,
    baseUrl: session.hueOrigin,
    maxAttempts: 1,
  });
  return session;
}

interface DriveOptions {
  surfaces: Array<"google.gmail/mcp" | "google.gmail/rest">;
  endpointFor(hueOrigin: string, attacker: { port: number }, surface: string): string;
}

async function drive(options: DriveOptions): Promise<{
  invoked: boolean;
  steered: boolean;
  attackerPresented: number;
  marker: boolean;
  mcpUrl?: string;
  hueOrigin: string;
}> {
  const session = await openHue(options.surfaces);
  const outputDirectory = await mkdtemp(join(tmpdir(), "hue-attempt-origin-case-"));
  const markerPath = join(outputDirectory, "agent-invoked");
  const hue = createHue({
    apiKey: API_KEY,
    baseUrl: session.hueOrigin,
    serviceName: "attempt-endpoint-origin",
    captureContent: false,
  });
  const environmentClient = createEnvironmentClient({
    apiKey: API_KEY,
    baseUrl: session.hueOrigin,
    maxAttempts: 1,
  });
  session.endpoints = Object.fromEntries(
    options.surfaces.map((surface) => [
      surface,
      options.endpointFor(session.hueOrigin, session.attacker, surface),
    ]),
  );
  const executionId = randomUUID();
  const fixture = session.fixture;
  let invoked = false;
  let steered = false;
  let marker = false;
  let mcpUrl: string | undefined;
  const hueOrigin = originOf(session.hueOrigin);
  try {
    await runEnvironmentTarget({
      client: session.client,
      environmentClient,
      hue,
      inputs: { task: "read" },
      deprecationWarnings: false,
      sealTiming: { maxGraceWaitMs: 0, pollMs: 1, waitMs: 50 },
      context: {
        config: {},
        item: {
          id: randomUUID(),
          externalKey: "origin-case",
          inputs: { task: "read" },
          metadata: {},
          datasetVersionId: randomUUID(),
          environmentVersionId: randomUUID(),
          hasExpected: false,
        },
        executionId,
        span: {
          traceId: "ab".repeat(16),
          spanId: "cd".repeat(8),
          span: { spanContext: () => ({ traceFlags: 1 }) },
          context: {},
          setInput() {},
          setOutput() {},
          setUsage() {},
        } as unknown as HueSpan,
        files: [],
        outputDirectory,
      },
      requested: {
        actualAgentManifest: fixture.actualManifest,
        expectedAgentManifestDigest: agentManifestDigestV2(fixture.actualManifest),
        requestedProviders: [
          { providerInstanceKey: "gmail-primary", surfaceKeys: options.surfaces },
        ],
        mcpSurface: { providerInstanceKey: "gmail-primary", surfaceKey: "google.gmail/mcp" },
      },
      async target(_inputs, context) {
        invoked = true;
        await writeFile(markerPath, "invoked");
        mcpUrl = context.mcp?.url;
        const handoff: Array<{ url: string; bearer: string }> = [];
        if (context.mcp) handoff.push({ url: context.mcp.url, bearer: context.mcp.token });
        for (const provider of context.connectionBundle?.providers ?? [])
          for (const surface of provider.surfaces)
            handoff.push({ url: surface.endpoint, bearer: surface.bearer });
        for (const item of handoff) {
          const target = connectTarget(item.url);
          if (target.hostname !== hueOrigin.hostname || target.port !== hueOrigin.port)
            steered = true;
          if (target.hostname !== "127.0.0.1") continue;
          await present(target, item.bearer);
        }
        return { ok: true };
      },
    });
  } catch {
    // A refused bundle must fail the attempt before the agent runs.
  } finally {
    marker = await readFile(markerPath, "utf8")
      .then((text) => text === "invoked")
      .catch(() => false);
    await hue.shutdownSafe({ timeoutMillis: 50 }).catch(() => undefined);
    await session.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
  return {
    invoked,
    steered,
    attackerPresented: session.attacker.presented,
    marker,
    mcpUrl,
    hueOrigin: session.hueOrigin,
  };
}

function present(
  target: { hostname: string; port: string; path: string },
  bearer: string,
): Promise<void> {
  return new Promise((resolve) => {
    const attempt = httpsRequest(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.path,
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}` },
        rejectUnauthorized: false,
        timeout: 1_000,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve());
      },
    );
    attempt.on("error", () => resolve());
    attempt.on("timeout", () => {
      attempt.destroy();
      resolve();
    });
    attempt.end();
  });
}
