import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { HueClient } from "../src/client.js";
import {
  createEnvironmentClient,
  type EnvironmentClient,
  type EnvironmentDefinition,
  type EnvironmentDefinitionV2,
  type PublishableEnvironmentDefinition,
} from "../src/environment.js";
import {
  actualAgentManifestV2,
  agentManifestDigestV2,
  attemptBaselineV2,
  attemptConnectionBundleV2,
  builtins,
  dependencyManifestV2,
  dependencyProviderV2,
  defineLocalScorer,
  executionManifestDigestV2,
  HueApiError,
  runSimulation,
  TargetOutcomeUncertainError,
  UncertainExecutionError,
  type EvaluationClient,
  type JsonValue,
  type SimulationProgress,
} from "../src/evals.js";

const project = {
  id: randomUUID(),
  organizationId: randomUUID(),
  name: "Synthetic",
  slug: "synthetic",
};
const baseUrl = "https://app.hue.test";
const checksum = "a".repeat(64);
const componentKeys = ["agent", "prompt", "model", "tools", "approvals", "orchestration"] as const;

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

function providerAttemptFixture() {
  const digest = (label: string) => canonicalDigest({ fixture: label });
  const catalogDigest = digest("gmail-catalog");
  const components = Object.fromEntries(
    componentKeys.map((key) => [key, { digest: digest(key), evidence: "observed" }]),
  );
  const actualManifest = actualAgentManifestV2.parse({
    schemaVersion: 2,
    components,
    catalogs: [
      {
        providerInstanceKey: "gmail-primary",
        surfaceKey: "google.gmail/mcp",
        digest: catalogDigest,
        evidence: "observed",
      },
    ],
    helperConfigurations: [],
  });
  const expectedManifest = {
    schemaVersion: 2 as const,
    components: Object.fromEntries(
      componentKeys.map((key) => [
        key,
        { digest: digest(key), minimumEvidence: "observed" as const },
      ]),
    ) as Record<(typeof componentKeys)[number], { digest: string; minimumEvidence: "observed" }>,
    catalogs: [
      {
        providerInstanceKey: "gmail-primary",
        surfaceKey: "google.gmail/mcp" as const,
        digest: catalogDigest,
        minimumEvidence: "observed" as const,
      },
    ],
    helperConfigurations: [],
  };
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
      contractDigests: [{ surfaceKey: "google.gmail/mcp", contractDigest: digest("mcp-contract") }],
    },
    workflowDigest: digest("workflow"),
    surfaces: [
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
  const expectedAgentManifestDigest = agentManifestDigestV2(expectedManifest);
  const baseline = attemptBaselineV2.parse({
    schemaVersion: 2,
    expectedAgentManifestId: randomUUID(),
    expectedAgentManifestDigest,
    expectedAgentManifest: expectedManifest,
    dependencyManifest,
  });
  const requestedProviders = [
    { providerInstanceKey: "gmail-primary", surfaceKeys: ["google.gmail/mcp" as const] },
  ];
  const mcpSurface = {
    providerInstanceKey: "gmail-primary",
    surfaceKey: "google.gmail/mcp" as const,
  };
  const bearer = "attempt-memory-only-bearer-000000000000000000000000";
  const bundle = (executionId: string, environmentRunId: string) => {
    const bindingId = randomUUID();
    return attemptConnectionBundleV2.parse({
      schemaVersion: 2,
      bindingId,
      executionId,
      environmentRunId,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      credentialGeneration: 0,
      providers: [
        {
          ...provider,
          surfaces: [
            {
              ...provider.surfaces[0]!,
              endpoint: `https://simulation.invalid/api/v1/provider-facades/${bindingId}/${randomUUID()}`,
              bearer,
            },
          ],
        },
      ],
      parity: {
        expectedAgentManifestId: baseline.expectedAgentManifestId,
        expectedAgentManifestDigest,
        actualAgentManifestDigest: agentManifestDigestV2(actualManifest),
        actualManifest,
        dependencyManifestDigest: canonicalDigest(dependencyManifest),
        executionManifestDigest: executionManifestDigestV2(actualManifest, dependencyManifest, {
          bindingId,
          executionId,
          environmentRunId,
        }),
        evidenceSource: "caller_supplied",
      },
    });
  };
  return { actualManifest, baseline, bearer, bundle, mcpSurface, requestedProviders };
}
const scenario = {
  kind: "repository" as const,
  name: "Repository scenario",
  slug: "repository-scenario",
  environment: {
    name: "Repository world",
    slug: "repository-world",
    definition: {
      schemaVersion: 1 as const,
      state: { collections: { records: {} } },
      actions: [
        {
          name: "save",
          semantics: {
            entry: "hue.collection.create@1" as const,
            config: { collection: "records", set: { value: true } },
          },
        },
      ],
    },
  },
  cases: [{ externalKey: "one", inputs: { task: "save" }, expected: "saved" }],
  scorers: [{ name: "Exact", slug: "exact", scorer: builtins.exactMatch() }],
};

function nodeHeavyEnvironmentDefinition(): EnvironmentDefinition {
  let deepest: JsonValue = "leaf";
  for (let depth = 0; depth < 32; depth++) deepest = { next: deepest };
  const records: Record<string, Record<string, JsonValue>> = {};
  for (let index = 0; index < 2000; index++) {
    const id = `r${String(index).padStart(4, "0")}`;
    records[id] =
      index === 0
        ? (deepest as Record<string, JsonValue>)
        : {
            id,
            flags: { rank: index, on: true, off: false },
            p: [0, 1, 2, 3, 4],
            s: [0, 1, 2],
          };
  }
  return {
    schemaVersion: 1,
    determinism: { clock: { startNs: "0", stepAdvanceNs: "1000000" } },
    state: { collections: { records } },
    actions: [
      {
        name: "list_records",
        params: [],
        semantics: {
          entry: "hue.collection.list@1",
          config: { collection: "records", guards: [], notFoundError: "not_found" },
        },
        observation: { projection: "identity" },
      },
    ],
    provenance: { kind: "handwritten" },
    metadata: {},
  };
}

function jsonNodeCount(value: unknown): number {
  const pending = [value];
  let count = 0;
  while (pending.length) {
    const item = pending.pop();
    count++;
    if (item !== null && typeof item === "object") pending.push(...Object.values(item));
  }
  return count;
}

function jsonDepth(value: unknown): number {
  const pending = [{ value, depth: 0 }];
  let maximum = 0;
  while (pending.length) {
    const item = pending.pop()!;
    maximum = Math.max(maximum, item.depth);
    if (item.value !== null && typeof item.value === "object")
      pending.push(
        ...Object.values(item.value).map((child) => ({ value: child, depth: item.depth + 1 })),
      );
  }
  return maximum;
}

function harness(
  options: {
    uncertainSeal?: boolean;
    evidenceFailures?: number;
    runInspectionFailures?: number;
    loseCompletionAcknowledgement?: boolean;
    loseSealAcknowledgement?: boolean;
  } = {},
) {
  const datasets = new Map<string, any>();
  const scorers = new Map<string, any>();
  const environments = new Map<string, any>();
  const experiments = new Map<string, any>();
  const executions = new Map<string, any>();
  const worlds = new Map<string, any>();
  const completions = new Map<string, any>();
  const results: any[] = [];
  const finishes: any[] = [];
  let targetCalls = 0;
  let loseCompletion = options.loseCompletionAcknowledgement ?? true;
  let loseSealAcknowledgement = options.loseSealAcknowledgement ?? true;
  let evidenceFailures = options.evidenceFailures ?? 1;
  let runInspectionFailures = options.runInspectionFailures ?? 0;
  const client = {
    baseUrl,
    checkConnection: async () => project,
    listDatasets: async () => ({ items: [], nextCursor: null }),
    createDataset: async (identity: any) => {
      const id = randomUUID();
      const draft = {
        id: randomUUID(),
        datasetId: id,
        version: 1,
        revision: 1,
        frozenAt: null,
        contentDigest: null,
      };
      const value = { id, ...identity, versions: [draft], cases: [] };
      datasets.set(id, value);
      return value;
    },
    getDataset: async (id: string) => datasets.get(id),
    createDatasetVersion: async (id: string) => {
      const dataset = datasets.get(id);
      const draft = {
        id: randomUUID(),
        datasetId: id,
        version: dataset.versions.length + 1,
        revision: 1,
        frozenAt: null,
        contentDigest: null,
      };
      dataset.versions.unshift(draft);
      dataset.cases = [];
      return draft;
    },
    listCases: async (id: string) => ({
      items: [...datasets.values()].find((value) => value.versions.some((v: any) => v.id === id))
        ?.cases,
      nextCursor: null,
    }),
    addCase: async (id: string, input: any) => {
      const dataset = [...datasets.values()].find((value) =>
        value.versions.some((v: any) => v.id === id),
      );
      const draft = dataset.versions.find((value: any) => value.id === id);
      const item = { id: randomUUID(), datasetVersionId: id, ...input };
      delete item.expectedRevision;
      dataset.cases.push(item);
      draft.revision++;
      return { item, version: draft };
    },
    getDatasetVersion: async (id: string) =>
      [...datasets.values()].flatMap((value) => value.versions).find((value) => value.id === id),
    freezeDatasetVersion: async (id: string) => {
      const version = await client.getDatasetVersion(id);
      version.frozenAt = new Date().toISOString();
      version.contentDigest = checksum;
      return version;
    },
    listScorers: async () => ({ items: [], nextCursor: null }),
    createScorer: async (identity: any) => {
      const value = { id: randomUUID(), ...identity, versions: [] };
      scorers.set(value.id, value);
      return value;
    },
    getScorer: async (id: string) => scorers.get(id),
    publishScorerVersion: async (id: string, definition: any) => {
      const version = { id: randomUUID(), contentDigest: checksum, definition };
      scorers.get(id).versions.push(version);
      return version;
    },
    createExperiment: async (input: any) => {
      const dataset = [...datasets.values()].find((value) =>
        value.versions.some((version: any) => version.id === input.datasetVersionId),
      );
      const scorerVersions = [...scorers.values()]
        .flatMap((value) => value.versions)
        .filter((value) => input.scorerVersionIds.includes(value.id));
      const id = randomUUID();
      const value = {
        id,
        name: input.name,
        datasetVersionId: input.datasetVersionId,
        config: input.config,
        configDigest: checksum,
        evaluation: {
          id: randomUUID(),
          name: "default",
          scorerVersions,
          itemCount: dataset.cases.length,
          scores: { scored: 0, error: 0, skipped: 0, pending: dataset.cases.length },
        },
        caseCount: dataset.cases.length,
        finishedAt: null,
        execution: {
          unstarted: dataset.cases.length,
          started: 0,
          uncertain: 0,
          succeeded: 0,
          error: 0,
          cancelled: 0,
        },
        cases: dataset.cases,
      };
      experiments.set(id, value);
      return { id, evaluationRunId: value.evaluation.id };
    },
    getExperiment: async (id: string) => experiments.get(id),
    listExperimentItems: async (id: string) => ({
      items: experiments.get(id).cases.map((item: any) => ({
        id: item.id,
        externalKey: item.externalKey,
        hasExpected: Object.hasOwn(item, "expected"),
        execution:
          [...executions.values()].find(
            (execution) => execution.experimentId === id && execution.caseId === item.id,
          ) ?? null,
      })),
      nextCursor: null,
    }),
    getExperimentCase: async (id: string, caseId: string) => {
      const item = experiments.get(id).cases.find((value: any) => value.id === caseId);
      return { ...item, hasExpected: Object.hasOwn(item, "expected") };
    },
    startExecution: async (experimentId: string, caseId: string, input: any) => {
      const execution = {
        id: randomUUID(),
        attempt: 1,
        state: "started",
        traceExternalId: input.traceExternalId,
        experimentId,
        caseId,
      };
      executions.set(execution.id, execution);
      return execution;
    },
    getExecution: async (id: string) => executions.get(id),
    getEnvironmentEvidence: async (executionId: string) => {
      if (evidenceFailures-- > 0) throw new HueApiError(503);
      const world = [...worlds.values()].find((value) => value.executionId === executionId);
      return {
        runId: world.id,
        executionId,
        environmentVersionId: world.environmentVersionId,
        definitionDigest: checksum,
        seed: "b".repeat(32),
        status: world.status,
        validity: world.validity,
        coverageGap: world.coverageGap,
        stepCount: world.steps.length,
        stateDigest: checksum,
        initialState: { collections: { records: {} } },
        finalState: { collections: { records: { saved: { value: true } } } },
      };
    },
    getEnvironmentSteps: async (executionId: string) => ({
      items: [...worlds.values()].find((value) => value.executionId === executionId).steps,
      nextCursor: null,
    }),
    completeExecution: async (id: string, input: any) => {
      const prior = completions.get(input.idempotencyKey);
      if (prior) return prior;
      const execution = executions.get(id);
      execution.state = input.state;
      const result = {
        executionId: id,
        subjectId: randomUUID(),
        traceSnapshotId: randomUUID(),
        evaluationItemId: randomUUID(),
      };
      completions.set(input.idempotencyKey, result);
      if (loseCompletion) {
        loseCompletion = false;
        throw new Error("lost completion acknowledgement");
      }
      return result;
    },
    submitResults: async (_runId: string, input: { results: any[] }) => {
      results.push(...input.results);
      return { ids: input.results.map(() => randomUUID()) };
    },
    finishExperiment: async (id: string) => {
      experiments.get(id).finishedAt = new Date().toISOString();
      return { id, finishedAt: experiments.get(id).finishedAt };
    },
    createSimulationMcpCapability: async (input: { runId: string }) => ({
      url: `${baseUrl}/api/v1/simulation-mcp/${input.runId}`,
      token: "attempt-scoped-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  } as unknown as EvaluationClient;
  const environmentClient = {
    baseUrl,
    listEnvironments: async () => ({ items: [], nextCursor: null }),
    createEnvironment: async (identity: any) => {
      const value = {
        id: randomUUID(),
        ...identity,
        description: identity.description ?? "",
        archivedAt: null,
        versions: [],
      };
      environments.set(value.id, value);
      return value;
    },
    getEnvironment: async (id: string) => environments.get(id),
    publishVersion: async (id: string) => {
      const version = {
        id: randomUUID(),
        version: 1,
        contentDigest: checksum,
        createdAt: new Date().toISOString(),
      };
      environments.get(id).versions.push(version);
      return version;
    },
    createRun: async (input: any) => {
      const world = {
        id: randomUUID(),
        environmentVersionId: input.environmentVersionId,
        executionId: input.executionId,
        status: "open",
        validity: "not_assessed",
        coverageGap: null,
        steps: [],
        actions: [
          {
            name: "save",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        ],
      };
      worlds.set(world.id, world);
      return {
        ...world,
        clockNs: "0",
        stateDigest: checksum,
        maxSteps: 500,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    act: async (runId: string, input: any) => {
      const world = worlds.get(runId);
      const step = {
        id: randomUUID(),
        ordinal: world.steps.length,
        invocationId: input.invocationId,
        action: input.action,
        args: input.args,
        observation: { status: "ok" },
        effects: [{ kind: "created", collection: "records", entityId: "saved", fields: ["value"] }],
        mutated: true,
        clockNs: "1",
        stateDigest: checksum,
      };
      world.steps.push(step);
      return {
        runId,
        stepOrdinal: step.ordinal,
        observation: step.observation,
        effects: step.effects,
        stateDigest: checksum,
        clockNs: "1",
        replayed: false,
        stepsRemaining: 499,
      };
    },
    recordCoverageGap: async (runId: string, input: any) => {
      const world = worlds.get(runId);
      const { idempotencyKey: _idempotencyKey, ...details } = input;
      world.validity = "environment_incomplete";
      world.coverageGap = {
        ...details,
        reportedAt: "2026-09-18T05:49:02.000Z",
        reportedBy: { kind: "project_key", id: randomUUID() },
      };
      return { runId, validity: world.validity, coverageGap: world.coverageGap };
    },
    finishRun: async (runId: string, input: any) => {
      finishes.push(input);
      if (options.uncertainSeal) throw new Error("world finalization unavailable");
      worlds.get(runId).status = input.status;
      const sealed = {
        id: runId,
        status: input.status,
        stepCount: worlds.get(runId).steps.length,
        stateDigest: checksum,
        sealedAt: new Date().toISOString(),
      };
      if (loseSealAcknowledgement) {
        loseSealAcknowledgement = false;
        throw new Error("lost seal acknowledgement");
      }
      return sealed;
    },
    getRun: async (runId: string) => {
      if (runInspectionFailures-- > 0) throw new Error("world inspection unavailable");
      return worlds.get(runId);
    },
  } as unknown as EnvironmentClient;
  const hue = {
    captureContent: false,
    transport: {
      options: { baseUrl },
      getFailureSequence: () => 0,
      getIssues: () => [],
      getReport: () => ({}),
    },
    checkConnection: async () => project,
    withSpan: async (_name: string, callback: any) =>
      callback({
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        span: {},
        context: ROOT_CONTEXT,
        setOutput() {},
      }),
    recordError() {},
    flush: async () => ({}),
    tool: async (_name: string, _input: JsonValue, execute: () => unknown) => execute(),
  } as unknown as HueClient;
  return {
    client,
    environmentClient,
    hue,
    worlds,
    experiments,
    scorers,
    results,
    finishes,
    targetCalls: () => targetCalls,
    target: async (_inputs: JsonValue, context: any) => {
      targetCalls++;
      expect(context.mcp.token).toBe("attempt-scoped-token");
      await context.tools.save.execute({});
      return "saved";
    },
  };
}

describe("one-shot simulation workflow", () => {
  test("publishes a server-valid aggregate world and preserves definition identity", async () => {
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const legacyDefinition = nodeHeavyEnvironmentDefinition();
    const definition: EnvironmentDefinitionV2 = {
      ...legacyDefinition,
      schemaVersion: 2,
      providerInstances: [
        {
          providerInstanceKey: "gmail-primary",
          providerId: "google.gmail",
          syntheticPrincipalId: "ABCDEFAB-1234-4ABC-8DEF-ABCDEFABCDEF",
          configuration: {
            kind: "gmail_mailbox/v1",
            messagesCollection: "records",
            draftsCollection: "records",
            mailboxAddress: "owner@example.test",
          },
        },
      ],
    };
    const definitionBytes = Buffer.byteLength(JSON.stringify(definition));
    const stateBytes = Buffer.byteLength(JSON.stringify(definition.state));
    const entities = Object.values(definition.state.collections.records!);
    expect(jsonNodeCount(definition)).toBeGreaterThan(20_000);
    expect(jsonDepth({ definition })).toBe(37);
    expect(entities).toHaveLength(2000);
    expect(
      Math.max(...entities.map((entity) => Buffer.byteLength(JSON.stringify(entity)))),
    ).toBeLessThanOrEqual(200_000);
    expect(Math.max(...entities.map(jsonNodeCount))).toBeLessThanOrEqual(20_000);
    expect(Math.max(...entities.map(jsonDepth))).toBe(32);
    expect(stateBytes).toBeGreaterThan(180_000);
    expect(stateBytes).toBeLessThanOrEqual(200_000);
    expect(definitionBytes).toBeGreaterThan(180_000);
    expect(definitionBytes).toBeLessThanOrEqual(240_000);

    const publications: Array<{
      path: string;
      definition: PublishableEnvironmentDefinition;
      contentDigest: string;
    }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-environment-key");
        const path = new URL(request.url).pathname;
        expect(request.method).toBe("POST");
        expect(path).toMatch(/^\/api\/v1\/environments\/[0-9a-f-]+\/versions$/);
        const body = (await request.json()) as { definition: PublishableEnvironmentDefinition };
        const canonicalDefinition = structuredClone(body.definition);
        if (canonicalDefinition.schemaVersion === 2)
          canonicalDefinition.providerInstances = canonicalDefinition.providerInstances.map(
            (instance) => ({
              ...instance,
              syntheticPrincipalId: instance.syntheticPrincipalId.toLowerCase(),
            }),
          );
        const contentDigest = canonicalDigest(canonicalDefinition).slice("sha256:".length);
        publications.push({ path, definition: body.definition, contentDigest });
        return Response.json(
          {
            id: randomUUID(),
            version: publications.length,
            contentDigest,
            createdAt: "2026-09-18T00:00:00.000Z",
          },
          { status: 201 },
        );
      },
    });
    const publishedClient = createEnvironmentClient({
      apiKey: "synthetic-environment-key",
      baseUrl: server.url.origin,
      maxAttempts: 1,
    });
    const originalEnvironmentClient = fixture.environmentClient;
    let identity: Awaited<ReturnType<EnvironmentClient["createEnvironment"]>> | undefined;
    const environmentClient = {
      ...originalEnvironmentClient,
      baseUrl: server.url.origin,
      listEnvironments: async () => ({
        items: identity ? [identity] : [],
        nextCursor: null,
      }),
      createEnvironment: async (input: Parameters<EnvironmentClient["createEnvironment"]>[0]) => {
        identity = await originalEnvironmentClient.createEnvironment(input);
        return identity;
      },
      publishVersion: async (
        environmentId: string,
        submitted: PublishableEnvironmentDefinition,
      ) => {
        const version = await publishedClient.publishVersion(environmentId, submitted);
        (await originalEnvironmentClient.getEnvironment(environmentId)).versions.push(version);
        return version;
      },
    } as EnvironmentClient;
    const client = { ...fixture.client, baseUrl: server.url.origin } as EvaluationClient;
    const hue = {
      ...fixture.hue,
      transport: {
        ...fixture.hue.transport,
        options: { ...fixture.hue.transport.options, baseUrl: server.url.origin },
      },
    } as HueClient;
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-large-world-"));
    try {
      const options = {
        ...fixture,
        client,
        environmentClient,
        hue,
        checkpointDirectory: directory,
        scenario: {
          ...scenario,
          environment: {
            ...scenario.environment,
            definition,
          },
        },
        persistResultContent: false,
        traceEvidence: { mode: "required" as const },
      };
      expect((await runSimulation(options)).experimentId).toBeTruthy();
      expect(publications).toHaveLength(1);
      expect(jsonNodeCount(publications[0]!.definition)).toBeGreaterThan(20_000);
      expect(jsonDepth({ definition: publications[0]!.definition })).toBe(37);
      expect(publications[0]!.definition).toMatchObject({
        schemaVersion: 2,
        providerInstances: [
          {
            providerInstanceKey: "gmail-primary",
            syntheticPrincipalId: "ABCDEFAB-1234-4ABC-8DEF-ABCDEFABCDEF",
          },
        ],
      });

      await runSimulation(options);
      // Server readback canonicalizes UUIDs to lowercase. The repository digest does
      // the same, so a casing-only input difference reuses this immutable version.
      expect(publications).toHaveLength(1);

      const changed = structuredClone(definition);
      changed.metadata = { revision: "changed" };
      await runSimulation({
        ...options,
        scenario: {
          ...options.scenario,
          environment: { ...options.scenario.environment, definition: changed },
        },
      });
      expect(publications).toHaveLength(2);
      expect(publications[1]!.contentDigest).not.toBe(publications[0]!.contentDigest);
      expect(fixture.targetCalls()).toBe(3);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("prepares V2 before the target and keeps credentials out of checkpoints", async () => {
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const attempt = providerAttemptFixture();
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-v2-ready-"));
    const progress: SimulationProgress[] = [];
    let targetCalls = 0;
    (fixture.client as any).prepareAttempt = async (input: any) => ({
      status: "ready",
      preflightReport: {
        schemaVersion: 2,
        status: "ready",
        evidenceSource: "caller_supplied",
        findings: [],
      },
      bundle: attempt.bundle(input.executionId, input.environmentRunId),
    });
    try {
      const report = await runSimulation({
        ...fixture,
        checkpointDirectory: directory,
        scenario: {
          ...scenario,
          config: { attemptBaselineV2: attempt.baseline },
        },
        actualAgentManifest: attempt.actualManifest,
        requestedProviders: attempt.requestedProviders,
        mcpSurface: attempt.mcpSurface,
        persistResultContent: false,
        traceEvidence: { mode: "required" },
        onProgress(event) {
          progress.push(event);
        },
        target: async (_inputs, context) => {
          targetCalls++;
          const bundle = context.connectionBundle;
          expect(bundle?.schemaVersion).toBe(2);
          if (!bundle) throw new Error("Expected a prepared connection bundle");
          expect(context.mcp).toEqual({
            url: bundle.providers[0]!.surfaces[0]!.endpoint,
            token: attempt.bearer,
            expiresAt: bundle.expiresAt,
          });
          await context.tools.save!.execute({});
          return "saved";
        },
      });
      expect(report.runUrl).toBe(`${baseUrl}/experiments/${report.experimentId}`);
      expect(targetCalls).toBe(1);
      expect(progress.map((event) => event.type)).toEqual([
        "run_created",
        "world_created",
        "attempt_prepared",
        "target_started",
        "world_sealed",
      ]);
      expect(fixture.finishes[0]?.idempotencyKey).toMatch(/^execution:[0-9a-f-]{36}:completed$/);
      const checkpointFiles = (await readdir(directory, { recursive: true })).filter((entry) =>
        entry.endsWith(".json"),
      );
      const checkpointText = (
        await Promise.all(checkpointFiles.map((entry) => readFile(join(directory, entry), "utf8")))
      ).join("\n");
      expect(checkpointText).not.toContain(attempt.bearer);
      expect(checkpointText).not.toContain("/api/v1/provider-facades/");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a V2 preflight gap skips the callback and scorer", async () => {
    let targetCalls = 0;
    let scorerCalls = 0;
    const scorer = defineLocalScorer({
      source: "must-not-score-a-preflight-gap",
      entrypoint: "score",
      metrics: [{ name: "quality", type: "boolean" }],
      score() {
        scorerCalls++;
        throw new Error("must not run");
      },
    });
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const attempt = providerAttemptFixture();
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-v2-incomplete-"));
    (fixture.client as any).prepareAttempt = async (input: any) => {
      const world = fixture.worlds.get(input.environmentRunId);
      world.validity = "environment_incomplete";
      world.coverageGap = {
        provider: "hue.attempt",
        operation: "prepare_attempt",
        code: "attempt_preflight_incomplete",
        args: { findingCodes: ["manifest_mismatch"] },
        description: "Attempt preflight could not establish the required simulation parity.",
        reportedAt: new Date().toISOString(),
        reportedBy: { kind: "project_key", id: randomUUID() },
      };
      return {
        status: "environment_incomplete",
        bindingId: randomUUID(),
        preflightReport: {
          schemaVersion: 2,
          status: "environment_incomplete",
          evidenceSource: "caller_supplied",
          findings: [
            {
              code: "manifest_mismatch",
              component: "tools",
              providerInstanceKey: null,
              surfaceKey: null,
              message: "The actual agent manifest does not match the experiment baseline.",
            },
          ],
        },
        gap: world.coverageGap,
      };
    };
    try {
      await runSimulation({
        ...fixture,
        checkpointDirectory: directory,
        scenario: {
          ...scenario,
          config: { attemptBaselineV2: attempt.baseline },
          scorers: [{ name: "Quality", slug: "quality", scorer }],
        },
        actualAgentManifest: attempt.actualManifest,
        requestedProviders: attempt.requestedProviders,
        mcpSurface: attempt.mcpSurface,
        persistResultContent: false,
        traceEvidence: { mode: "required" },
        target: async () => {
          targetCalls++;
          return "must not run";
        },
      });
      expect(targetCalls).toBe(0);
      expect(scorerCalls).toBe(0);
      expect(fixture.results).toEqual([
        expect.objectContaining({
          state: "skipped",
          explanation: "Environment incomplete: provider behavior is not implemented.",
        }),
      ]);
      expect([...fixture.worlds.values()][0]).toMatchObject({
        status: "completed",
        validity: "environment_incomplete",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a lost V2 prepare acknowledgement stays uncertain and never replays the callback", async () => {
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const attempt = providerAttemptFixture();
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-v2-uncertain-"));
    let prepareCalls = 0;
    let targetCalls = 0;
    (fixture.client as any).prepareAttempt = async () => {
      prepareCalls++;
      throw new HueApiError();
    };
    const options = {
      ...fixture,
      checkpointDirectory: directory,
      scenario: {
        ...scenario,
        config: { attemptBaselineV2: attempt.baseline },
      },
      actualAgentManifest: attempt.actualManifest,
      requestedProviders: attempt.requestedProviders,
      mcpSurface: attempt.mcpSurface,
      persistResultContent: false,
      traceEvidence: { mode: "required" as const },
      target: async () => {
        targetCalls++;
        return "must not run";
      },
    };
    try {
      await expect(runSimulation(options)).rejects.toBeInstanceOf(TargetOutcomeUncertainError);
      await expect(runSimulation(options)).rejects.toBeInstanceOf(UncertainExecutionError);
      expect(prepareCalls).toBe(1);
      expect(targetCalls).toBe(0);
      expect([...fixture.worlds.values()][0]?.status).toBe("open");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("publishes the supported scorer defaults and rejects server-only scorer kinds", async () => {
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-scorer-defaults-"));
    try {
      await runSimulation({
        ...fixture,
        checkpointDirectory: directory,
        scenario: {
          ...scenario,
          scorers: [
            {
              name: "Judge",
              slug: "judge",
              scorer: {
                kind: "llm_judge",
                config: {
                  model: "openai/gpt-5",
                  provider: "openai",
                  rubric: "  Assess quality  ",
                  bindings: [{ name: "output", path: "/output" }],
                },
                metrics: [{ name: "quality", type: "boolean" }],
              } as any,
            },
          ],
        },
        persistResultContent: false,
        traceEvidence: { mode: "required" },
      });
      expect([...fixture.scorers.values()][0]?.versions[0]?.definition).toMatchObject({
        config: {
          rubric: "Assess quality",
          bindings: [{ name: "output", path: "/output", required: true }],
          maxOutputTokens: 1024,
          timeoutMs: 60_000,
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const unsupported = harness();
    const unsupportedDirectory = await mkdtemp(
      join(tmpdir(), "hue-simulation-unsupported-scorer-"),
    );
    try {
      await expect(
        runSimulation({
          ...unsupported,
          checkpointDirectory: unsupportedDirectory,
          scenario: {
            ...scenario,
            scorers: [
              {
                name: "Document verifier",
                slug: "document-verifier",
                scorer: { kind: "document_verifier", metrics: [] } as any,
              },
            ],
          },
          persistResultContent: false,
          traceEvidence: { mode: "required" },
        }),
      ).rejects.toThrow("Unsupported or invalid SDK scorer definition");
      expect(unsupported.scorers.size).toBe(0);
      expect(unsupported.worlds.size).toBe(0);
      expect(unsupported.targetCalls()).toBe(0);
    } finally {
      await rm(unsupportedDirectory, { recursive: true, force: true });
    }
  });

  test("rejects invalid world limits before consuming a scenario case", async () => {
    const fixture = harness();
    const options = {
      ...fixture,
      checkpointDirectory: join(tmpdir(), "unused-hue-simulation-checkpoint"),
      scenario,
      persistResultContent: false,
      traceEvidence: { mode: "required" as const },
    };

    await expect(runSimulation({ ...options, maxSteps: 501 })).rejects.toThrow(
      "maxSteps must be 1–500",
    );
    await expect(runSimulation({ ...options, ttlSeconds: 86_401 })).rejects.toThrow(
      "ttlSeconds must be 1–86400",
    );
    expect(fixture.targetCalls()).toBe(0);
    expect(fixture.worlds.size).toBe(0);
    expect(fixture.experiments.size).toBe(0);
  });

  test("recovers an upload without rerunning the target and reruns in a fresh world", async () => {
    const fixture = harness();
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-"));
    const options = {
      ...fixture,
      checkpointDirectory: directory,
      scenario,
      persistResultContent: false,
      traceEvidence: { mode: "required" as const },
    };
    try {
      let firstError: unknown;
      try {
        await runSimulation(options);
      } catch (error) {
        firstError = error;
      }
      expect((firstError as Error).message).toContain("lost completion acknowledgement");
      const recovered = await runSimulation(options);
      expect(fixture.targetCalls()).toBe(1);
      expect(recovered.runUrl).toBe(`${baseUrl}/experiments/${recovered.experimentId}`);
      const repeated = await runSimulation(options);
      expect(fixture.targetCalls()).toBe(2);
      expect(repeated.experimentId).not.toBe(recovered.experimentId);
      const appAuthored = await runSimulation({
        ...options,
        checkpointDirectory: join(directory, "app-authored"),
        scenario: { kind: "experiment", experimentId: recovered.experimentId },
      });
      expect(fixture.targetCalls()).toBe(3);
      expect(appAuthored.experimentId).not.toBe(recovered.experimentId);
      expect(new Set([...fixture.worlds.values()].map((world) => world.id)).size).toBe(3);
      expect([...fixture.experiments.values()].every((item) => item.finishedAt)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an unconfirmed world seal stays uncertain and never reruns the target", async () => {
    const fixture = harness({ uncertainSeal: true });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-uncertain-"));
    const options = {
      ...fixture,
      checkpointDirectory: directory,
      scenario,
      persistResultContent: false,
      traceEvidence: { mode: "required" as const },
    };
    try {
      await expect(runSimulation(options)).rejects.toBeInstanceOf(TargetOutcomeUncertainError);
      expect(fixture.targetCalls()).toBe(1);
      await expect(runSimulation(options)).rejects.toBeInstanceOf(UncertainExecutionError);
      expect(fixture.targetCalls()).toBe(1);
      expect([...fixture.worlds.values()][0]?.status).toBe("open");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("publishes the run URL before target work and cancels without invoking the callback", async () => {
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-cancelled-"));
    const controller = new AbortController();
    const progress: SimulationProgress[] = [];
    controller.abort(new Error("stop requested"));
    try {
      const report = await runSimulation({
        ...fixture,
        checkpointDirectory: directory,
        scenario,
        persistResultContent: false,
        traceEvidence: { mode: "required" },
        signal: controller.signal,
        onProgress(event) {
          progress.push(event);
        },
      });
      expect(fixture.targetCalls()).toBe(0);
      expect(progress.map((event) => event.type)).toEqual([
        "run_created",
        "world_created",
        "world_sealed",
      ]);
      expect(progress[0]).toEqual({
        type: "run_created",
        experimentId: report.experimentId,
        runUrl: report.runUrl,
      });
      expect([...fixture.worlds.values()][0]?.status).toBe("abandoned");
      const [item] = (await fixture.client.listExperimentItems(report.experimentId)).items;
      expect(item?.execution?.state).toBe("cancelled");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a durably reported provider gap is inconclusive, not a target or scorer verdict", async () => {
    let scorerCalls = 0;
    let callbackCalls = 0;
    const scorer = defineLocalScorer({
      source: "must-not-score-an-incomplete-world",
      entrypoint: "score",
      metrics: [{ name: "quality", type: "boolean" }],
      score() {
        scorerCalls++;
        throw new Error("must not run");
      },
    });
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-incomplete-"));
    try {
      const report = await runSimulation({
        ...fixture,
        checkpointDirectory: directory,
        scenario: {
          ...scenario,
          scorers: [{ name: "Quality", slug: "quality", scorer }],
        },
        persistResultContent: false,
        traceEvidence: { mode: "required" },
        target: async (_inputs, context) => {
          callbackCalls++;
          await fixture.environmentClient.recordCoverageGap(context.environmentRunId, {
            idempotencyKey: randomUUID(),
            provider: "google.gmail.mcp",
            operation: "create_draft",
            code: "standalone_draft_unsupported",
            args: { to: ["synthetic-recipient@example.test"] },
            description: "Standalone new-message drafts are not implemented.",
          });
          const error = new Error("The simulated provider does not support this operation");
          error.name = "EnvironmentIncompleteError";
          throw error;
        },
      });
      expect(callbackCalls).toBe(1);
      expect(scorerCalls).toBe(0);
      expect(fixture.results).toEqual([
        expect.objectContaining({
          state: "skipped",
          explanation: "Environment incomplete: provider behavior is not implemented.",
        }),
      ]);
      const [item] = (await fixture.client.listExperimentItems(report.experimentId)).items;
      expect(item?.execution?.state).toBe("succeeded");
      expect([...fixture.worlds.values()][0]).toMatchObject({
        status: "completed",
        validity: "environment_incomplete",
        coverageGap: {
          provider: "google.gmail.mcp",
          operation: "create_draft",
          code: "standalone_draft_unsupported",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an unconfirmed provider gap stays uncertain and never replays the callback", async () => {
    const fixture = harness({
      evidenceFailures: 0,
      runInspectionFailures: 1,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-gap-uncertain-"));
    let callbackCalls = 0;
    const options = {
      ...fixture,
      checkpointDirectory: directory,
      scenario,
      persistResultContent: false,
      traceEvidence: { mode: "required" as const },
      target: async (_inputs: JsonValue, context: any) => {
        callbackCalls++;
        await fixture.environmentClient.recordCoverageGap(context.environmentRunId, {
          idempotencyKey: randomUUID(),
          provider: "google.gmail.mcp",
          operation: "create_draft",
          code: "standalone_draft_unsupported",
          args: {},
          description: "Standalone new-message drafts are not implemented.",
        });
        throw new Error("Environment incomplete");
      },
    };
    try {
      await expect(runSimulation(options)).rejects.toBeInstanceOf(TargetOutcomeUncertainError);
      expect(callbackCalls).toBe(1);
      await expect(runSimulation(options)).rejects.toBeInstanceOf(UncertainExecutionError);
      expect(callbackCalls).toBe(1);
      expect([...fixture.worlds.values()][0]?.status).toBe("open");
      expect(fixture.results).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("simulation candidates cannot read grading references or mutate pinned case data", async () => {
  const fixture = harness({
    evidenceFailures: 0,
    loseCompletionAcknowledgement: false,
    loseSealAcknowledgement: false,
  });
  const directory = await mkdtemp(join(tmpdir(), "hue-candidate-boundary-"));
  const privateScenario = {
    ...scenario,
    config: { settings: { temperature: 0 } },
    cases: [
      {
        externalKey: "one",
        inputs: { task: "save" },
        expected: "saved",
        metadata: { rubric: "evaluator-private" },
      },
    ],
  };
  try {
    const report = await runSimulation({
      ...fixture,
      checkpointDirectory: directory,
      scenario: privateScenario,
      persistResultContent: false,
      traceEvidence: { mode: "required" },
      target: async (inputs, context) => {
        expect(Object.keys(context.item).sort()).toEqual(["externalKey", "id"]);
        expect(Object.keys(context.mcp).sort()).toEqual(["expiresAt", "token", "url"]);
        expect(JSON.stringify(context)).not.toContain("evaluator-private");
        (inputs as { task: string }).task = "changed";
        (context.config as { settings: { temperature: number } }).settings.temperature = 1;
        await context.tools.save!.execute({});
        return "saved";
      },
    });
    const stored = fixture.experiments.get(report.experimentId);
    expect(stored.cases[0].inputs).toEqual({ task: "save" });
    expect(stored.config).toEqual({ settings: { temperature: 0 } });
    expect([...fixture.results.values()].length).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
