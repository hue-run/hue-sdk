import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  actualAgentManifestV2,
  agentManifestDigestV2,
  attemptConnectionBundleV2,
  dependencyManifestV2,
  dependencyProviderV2,
  executionManifestDigestV2,
  prepareAttemptInputV2,
  type ActualAgentManifestV2,
  type AttemptBindingRead,
  type AttemptConnectionBundleV2,
  type PrepareAttemptRequestV2,
  createEvaluationClient,
  HueApiError,
} from "../src/evals.js";

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
    throw new Error("Invalid fixture digest input");
  }
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

const digest = (label: string) => canonicalDigest({ fixture: label });
const componentKeys = ["agent", "prompt", "model", "tools", "approvals", "orchestration"] as const;

function fixture() {
  const executionId = randomUUID();
  const environmentRunId = randomUUID();
  const bindingId = randomUUID();
  const expectedAgentManifestId = randomUUID();
  const catalogDigest = digest("gmail-catalog");
  const helperConfigurationDigest = digest("gmail-helper");
  const actualManifest = actualAgentManifestV2.parse({
    schemaVersion: 2,
    components: Object.fromEntries(
      componentKeys.map((key) => [key, { digest: digest(key), evidence: "observed" }]),
    ),
    catalogs: [
      {
        providerInstanceKey: "gmail-primary",
        surfaceKey: "google.gmail/mcp",
        digest: catalogDigest,
        evidence: "observed",
      },
    ],
    helperConfigurations: [
      {
        providerInstanceKey: "gmail-primary",
        surfaceKey: "google.gmail/rest",
        digest: helperConfigurationDigest,
        evidence: "observed",
      },
    ],
  });
  const expectedAgentManifestDigest = agentManifestDigestV2(actualManifest);
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
        { surfaceKey: "google.gmail/mcp", contractDigest: digest("mcp-contract") },
        { surfaceKey: "google.gmail/rest", contractDigest: digest("rest-contract") },
      ],
    },
    workflowDigest: digest("workflow"),
    surfaces: [
      {
        surfaceRegistrationId: "test.gmail.rest.v2",
        surfaceKey: "google.gmail/rest",
        protocolVersion: "v1",
        contractDigest: digest("rest-contract"),
        catalogDigest: null,
        helperConfigurationDigest,
        runtimeRegistrationDigest: digest("rest-registration"),
      },
      {
        surfaceRegistrationId: "test.gmail.mcp.v2",
        surfaceKey: "google.gmail/mcp",
        protocolVersion: "2025-06-18",
        contractDigest: digest("mcp-contract"),
        catalogDigest,
        helperConfigurationDigest: null,
        runtimeRegistrationDigest: digest("mcp-registration"),
      },
    ],
  });
  const dependencyManifest = dependencyManifestV2.parse({
    schemaVersion: 2,
    providers: [provider],
  });
  const parity = {
    expectedAgentManifestId,
    expectedAgentManifestDigest,
    actualAgentManifestDigest: expectedAgentManifestDigest,
    actualManifest,
    dependencyManifestDigest: canonicalDigest(dependencyManifest),
    executionManifestDigest: executionManifestDigestV2(actualManifest, dependencyManifest, {
      bindingId,
      executionId,
      environmentRunId,
    }),
    evidenceSource: "caller_supplied" as const,
  };
  const bundle = (generation: number, bearer: string): AttemptConnectionBundleV2 =>
    attemptConnectionBundleV2.parse({
      schemaVersion: 2,
      bindingId,
      executionId,
      environmentRunId,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      credentialGeneration: generation,
      providers: [
        {
          ...provider,
          surfaces: provider.surfaces.map((surface) => ({
            ...surface,
            endpoint: `https://simulation.invalid/api/v1/provider-facades/${bindingId}/${randomUUID()}`,
            bearer,
          })),
        },
      ],
      parity,
    });
  const request = prepareAttemptInputV2.parse({
    schemaVersion: 2,
    idempotencyKey: randomUUID(),
    executionId,
    environmentRunId,
    expectedAgentManifestDigest,
    actualManifest,
    requestedProviders: [
      {
        providerInstanceKey: "gmail-primary",
        surfaceKeys: ["google.gmail/rest", "google.gmail/mcp"],
      },
    ],
  });
  return { request, bundle, bindingId };
}

describe("attempt connection client", () => {
  test("prepares V2, omits the path identity from JSON, rotates and revokes without drift", async () => {
    const data = fixture();
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    let drift = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = request.method === "GET" ? undefined : await request.json();
        requests.push({ method: request.method, path, ...(body === undefined ? {} : { body }) });
        if (path.endsWith("/prepare-attempt"))
          return Response.json({
            status: "ready",
            preflightReport: {
              schemaVersion: 2,
              status: "ready",
              evidenceSource: "caller_supplied",
              findings: [],
            },
            bundle: data.bundle(0, "a".repeat(48)),
          });
        if (path.endsWith("/refresh")) {
          const bundle = data.bundle(1, "b".repeat(48));
          if (drift)
            bundle.providers[0]!.surfaces[0]!.helperConfigurationDigest =
              digest("untrusted-change");
          return Response.json({
            status: "ready",
            preflightReport: {
              schemaVersion: 2,
              status: "ready",
              evidenceSource: "caller_supplied",
              findings: [],
            },
            bundle,
          });
        }
        if (path.endsWith("/revoke"))
          return Response.json({ bindingId: data.bindingId, revokedAt: new Date().toISOString() });
        return new Response(null, { status: 404 });
      },
    });
    const client = createEvaluationClient({
      apiKey: "synthetic-project-key",
      baseUrl: server.url.origin,
    });
    try {
      const prepared = await client.prepareAttempt(data.request);
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") throw new Error("Expected ready fixture");
      expect(prepared.bundle.providers[0]!.surfaces.map((surface) => surface.surfaceKey)).toEqual([
        "google.gmail/rest",
        "google.gmail/mcp",
      ]);
      const refreshKey = randomUUID();
      const refreshed = await client.refreshAttemptConnection(prepared.bundle, {
        idempotencyKey: refreshKey,
      });
      expect(refreshed.bundle).toMatchObject({
        bindingId: prepared.bundle.bindingId,
        credentialGeneration: 1,
      });
      const { executionId: _pathIdentity, ...prepareBody } = data.request;
      expect(requests[0]).toEqual({
        method: "POST",
        path: `/api/v1/experiment-executions/${data.request.executionId}/prepare-attempt`,
        body: prepareBody,
      });
      expect(requests[1]).toEqual({
        method: "POST",
        path: `/api/v1/attempt-bindings/${data.bindingId}/refresh`,
        body: { idempotencyKey: refreshKey, expectedGeneration: 0 },
      });
      expect(await client.revokeAttemptConnection({ bindingId: data.bindingId })).toMatchObject({
        bindingId: data.bindingId,
      });
      drift = true;
      await expect(
        client.refreshAttemptConnection(prepared.bundle, { idempotencyKey: randomUUID() }),
      ).rejects.toBeInstanceOf(HueApiError);
    } finally {
      server.stop(true);
    }
  });

  test("normalizes omitted actual evidence to explicit V2 missing evidence", async () => {
    const data = fixture();
    let body: unknown;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        body = await request.json();
        const input = body as Record<string, unknown>;
        return Response.json({
          status: "environment_incomplete",
          bindingId: data.bindingId,
          preflightReport: {
            schemaVersion: 2,
            status: "environment_incomplete",
            evidenceSource: "caller_supplied",
            findings: [
              {
                code: "evidence_missing",
                component: "agent",
                providerInstanceKey: null,
                surfaceKey: null,
                message: "Required parity evidence is missing.",
              },
            ],
          },
          gap: {
            provider: "hue.attempt",
            operation: "prepare_attempt",
            code: "attempt_preflight_incomplete",
            args: { findingCodes: ["evidence_missing"] },
            description: "Attempt preflight could not establish the required simulation parity.",
            reportedAt: new Date().toISOString(),
            reportedBy: { kind: "project_key", id: randomUUID() },
          },
          ignored: input.executionId,
        });
      },
    });
    const client = createEvaluationClient({
      apiKey: "synthetic-project-key",
      baseUrl: server.url.origin,
    });
    try {
      const request: PrepareAttemptRequestV2 = {
        ...data.request,
        actualManifest: undefined,
      };
      const result = await client.prepareAttempt(request);
      expect(result.status).toBe("environment_incomplete");
      expect(body).toMatchObject({
        schemaVersion: 2,
        actualManifest: {
          schemaVersion: 2,
          components: Object.fromEntries(
            componentKeys.map((key) => [key, { digest: null, evidence: "missing" }]),
          ),
          catalogs: [],
          helperConfigurations: [],
        },
      });
      expect(body).not.toHaveProperty("executionId");
    } finally {
      server.stop(true);
    }
  });

  test("reads coupled secret-free V1 evidence without treating it as a live connection", async () => {
    const data = fixture();
    const read: AttemptBindingRead = {
      schemaVersion: 1,
      bindingId: data.bindingId,
      executionId: data.request.executionId,
      environmentRunId: data.request.environmentRunId,
      outcome: "environment_incomplete",
      credentialGeneration: null,
      expectedAgentManifestId: null,
      expectedAgentManifestDigest: null,
      actualManifest: {
        schemaVersion: 1,
        components: Object.fromEntries(
          componentKeys.map((key) => [key, { digest: null, evidence: "missing" }]),
        ) as ActualAgentManifestV2["components"],
        catalogs: [],
      },
      dependencyManifest: null,
      executionManifestDigest: null,
      preflightReport: {
        schemaVersion: 1,
        status: "environment_incomplete",
        evidenceSource: "caller_supplied",
        findings: [
          {
            code: "baseline_missing",
            component: null,
            providerInstanceKey: null,
            surfaceKey: null,
            message: "The immutable attempt baseline is unavailable.",
          },
        ],
      },
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json(read);
      },
    });
    const client = createEvaluationClient({
      apiKey: "synthetic-project-key",
      baseUrl: server.url.origin,
    });
    try {
      const result = await client.getAttemptBinding(data.bindingId);
      expect(result).toEqual(read);
      expect(JSON.stringify(result)).not.toContain("bearer");
      const mixed = structuredClone(read) as Record<string, unknown>;
      mixed.actualManifest = data.request.actualManifest;
      const malformed = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return Response.json(mixed);
        },
      });
      try {
        const malformedClient = createEvaluationClient({
          apiKey: "synthetic-project-key",
          baseUrl: malformed.url.origin,
        });
        await expect(malformedClient.getAttemptBinding(data.bindingId)).rejects.toBeInstanceOf(
          HueApiError,
        );
      } finally {
        malformed.stop(true);
      }
    } finally {
      server.stop(true);
    }
  });

  test("rejects invalid inputs before HTTP and sanitizes malformed credential responses", async () => {
    const data = fixture();
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return Response.json({ status: "ready", credential: "must-not-escape" });
      },
    });
    const client = createEvaluationClient({
      apiKey: "synthetic-project-key",
      baseUrl: server.url.origin,
    });
    try {
      const invalid = structuredClone(data.request);
      invalid.actualManifest.helperConfigurations[0] = {
        ...invalid.actualManifest.helperConfigurations[0]!,
        digest: null,
        evidence: "observed",
      };
      await expect(client.prepareAttempt(invalid)).rejects.toThrow();
      expect(requests).toBe(0);
      try {
        await client.prepareAttempt(data.request);
        throw new Error("Expected malformed response rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(HueApiError);
        expect(String(error)).not.toContain("must-not-escape");
      }
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
