import { createHash } from "node:crypto";
import { z } from "zod";
import type { CoverageGap } from "../environment/types.js";
import type { JsonValue } from "./types.js";
import { json, valueBounds } from "./json.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const surfaceKey = z.enum(["google.gmail/mcp", "google.gmail/rest", "slack/mcp", "slack/web-api"]);
const mcpSurfaceKey = z.enum(["google.gmail/mcp", "slack/mcp"]);
const nativeSurfaceKey = z.enum(["google.gmail/rest", "slack/web-api"]);
const providerInstanceKey = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const componentKey = z.enum(["agent", "prompt", "model", "tools", "approvals", "orchestration"]);
const componentKeys = componentKey.options;
const surfaceRegistrationId = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);
const evidence = z.enum(["observed", "declared", "missing"]);
const digestEvidence = z
  .strictObject({ digest: sha256Digest.nullable(), evidence })
  .refine(
    (value) => (value.evidence === "missing") === (value.digest === null),
    "Missing evidence must have a null digest; other evidence must have a digest",
  );
const digestRequirement = z.strictObject({
  digest: sha256Digest,
  minimumEvidence: z.enum(["observed", "declared"]),
});
const missingEvidence = () => ({ digest: null, evidence: "missing" }) as const;
const missingComponents = () =>
  Object.fromEntries(componentKeys.map((key) => [key, missingEvidence()])) as Record<
    (typeof componentKeys)[number],
    ReturnType<typeof missingEvidence>
  >;
const components = z
  .strictObject({
    agent: digestEvidence.default(missingEvidence),
    prompt: digestEvidence.default(missingEvidence),
    model: digestEvidence.default(missingEvidence),
    tools: digestEvidence.default(missingEvidence),
    approvals: digestEvidence.default(missingEvidence),
    orchestration: digestEvidence.default(missingEvidence),
  })
  .default(missingComponents);
const requirements = z.strictObject({
  agent: digestRequirement,
  prompt: digestRequirement,
  model: digestRequirement,
  tools: digestRequirement,
  approvals: digestRequirement,
  orchestration: digestRequirement,
});

function unique<T>(items: T[], key: (item: T) => string) {
  return new Set(items.map(key)).size === items.length;
}

function sorted<T>(items: T[], key: (item: T) => string) {
  return items.every((item, index) => index === 0 || key(items[index - 1]!) < key(item));
}

const catalogIdentityV2 = { providerInstanceKey, surfaceKey: mcpSurfaceKey };
const helperIdentityV2 = { providerInstanceKey, surfaceKey: nativeSurfaceKey };
const actualHelperEvidence = z
  .array(
    z
      .strictObject({
        ...helperIdentityV2,
        digest: sha256Digest.nullable(),
        evidence,
      })
      .refine((value) => (value.evidence === "missing") === (value.digest === null)),
  )
  .max(64)
  .refine((items) => unique(items, (item) => `${item.providerInstanceKey}/${item.surfaceKey}`));
const expectedHelperEvidence = z
  .array(
    z.strictObject({
      ...helperIdentityV2,
      digest: sha256Digest,
      minimumEvidence: z.enum(["observed", "declared"]),
    }),
  )
  .max(64)
  .refine((items) => unique(items, (item) => `${item.providerInstanceKey}/${item.surfaceKey}`));

export const actualAgentManifestV2 = z
  .strictObject({
    schemaVersion: z.literal(2).default(2),
    components,
    /** Effective model-visible order. Never sort this sequence. */
    catalogs: z
      .array(
        z
          .strictObject({
            ...catalogIdentityV2,
            digest: sha256Digest.nullable(),
            evidence,
          })
          .refine((value) => (value.evidence === "missing") === (value.digest === null)),
      )
      .max(64)
      .refine((items) => unique(items, (item) => `${item.providerInstanceKey}/${item.surfaceKey}`))
      .default(() => []),
    helperConfigurations: actualHelperEvidence.default(() => []),
  })
  .default(() => ({
    schemaVersion: 2 as const,
    components: missingComponents(),
    catalogs: [],
    helperConfigurations: [],
  }));
export type ActualAgentManifestV2 = z.infer<typeof actualAgentManifestV2>;
export type ActualAgentManifestInputV2 = z.input<typeof actualAgentManifestV2>;

export const expectedAgentManifestV2 = z.strictObject({
  schemaVersion: z.literal(2),
  components: requirements,
  catalogs: z
    .array(
      z.strictObject({
        ...catalogIdentityV2,
        digest: sha256Digest,
        minimumEvidence: z.enum(["observed", "declared"]),
      }),
    )
    .max(64)
    .refine((items) => unique(items, (item) => `${item.providerInstanceKey}/${item.surfaceKey}`)),
  helperConfigurations: expectedHelperEvidence,
});
export type ExpectedAgentManifestV2 = z.infer<typeof expectedAgentManifestV2>;

const contractDigestsV2 = z
  .array(z.strictObject({ surfaceKey, contractDigest: sha256Digest }))
  .min(1)
  .max(4)
  .refine(
    (items) => sorted(items, (item) => item.surfaceKey),
    "Contract digests must be sorted and unique by surface key",
  );
const profilePinsV2 = z.strictObject({
  profileId: z.string().regex(/^[a-z][a-z0-9._/-]{0,127}$/),
  profileDigest: sha256Digest,
  buildDigest: sha256Digest,
  coverageDigest: sha256Digest,
  contractDigests: contractDigestsV2,
});
const surfaceFieldsV2 = {
  surfaceRegistrationId,
  protocolVersion: z.string().regex(/^[a-zA-Z0-9._/+-]{1,64}$/),
  contractDigest: sha256Digest,
  runtimeRegistrationDigest: sha256Digest,
};
const mcpSurfaceV2 = z.strictObject({
  ...surfaceFieldsV2,
  surfaceKey: mcpSurfaceKey,
  catalogDigest: sha256Digest,
  helperConfigurationDigest: z.null(),
});
const nativeSurfaceV2 = z.strictObject({
  ...surfaceFieldsV2,
  surfaceKey: nativeSurfaceKey,
  catalogDigest: z.null(),
  helperConfigurationDigest: sha256Digest,
});
export const surfaceBindingV2 = z.discriminatedUnion("surfaceKey", [mcpSurfaceV2, nativeSurfaceV2]);
export type SurfaceBindingV2 = z.infer<typeof surfaceBindingV2>;

const providerFieldsV2 = {
  providerInstanceKey,
  providerId: z.enum(["google.gmail", "slack"]),
  syntheticPrincipalId: canonicalUuid,
  scopes: z
    .array(z.string().regex(/^[a-zA-Z0-9._:/-]{1,256}$/))
    .max(64)
    .refine((items) => sorted(items, (item) => item), "Scopes must be sorted and unique"),
  profile: profilePinsV2,
  workflowDigest: sha256Digest,
  surfaces: z
    .array(surfaceBindingV2)
    .min(1)
    .max(4)
    .refine(
      (items) => unique(items, (item) => item.surfaceKey),
      "Selected surfaces must be unique",
    ),
};
const providerBaseV2 = z.strictObject(providerFieldsV2);
function validProviderV2(value: z.infer<typeof providerBaseV2>) {
  return (
    value.profile.contractDigests.every((item) =>
      item.surfaceKey.startsWith(`${value.providerId}/`),
    ) &&
    value.surfaces.every(
      (item) =>
        item.surfaceKey.startsWith(`${value.providerId}/`) &&
        value.profile.contractDigests.some(
          (contract) =>
            contract.surfaceKey === item.surfaceKey &&
            contract.contractDigest === item.contractDigest,
        ),
    )
  );
}
export const dependencyProviderV2 = providerBaseV2.refine(
  validProviderV2,
  "Selected surface contracts must match the pinned profile and provider",
);
export type DependencyProviderV2 = z.infer<typeof dependencyProviderV2>;

export const dependencyManifestV2 = z.strictObject({
  schemaVersion: z.literal(2),
  providers: z
    .array(dependencyProviderV2)
    .min(1)
    .max(16)
    .refine(
      (items) => unique(items, (item) => item.providerInstanceKey),
      "Provider instances must be unique",
    ),
});
export type DependencyManifestV2 = z.infer<typeof dependencyManifestV2>;

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
    throw new Error("Digest input must be bounded JSON values");
  }
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function agentManifestDigestV2(
  manifest: ActualAgentManifestV2 | ExpectedAgentManifestV2,
): string {
  return canonicalDigest({
    schemaVersion: 2,
    components: Object.fromEntries(
      componentKeys.map((key) => [key, manifest.components[key].digest]),
    ),
    catalogs: manifest.catalogs.map(({ providerInstanceKey, surfaceKey: key, digest }) => ({
      providerInstanceKey,
      surfaceKey: key,
      digest,
    })),
    helperConfigurations: manifest.helperConfigurations.map(
      ({ providerInstanceKey, surfaceKey: key, digest }) => ({
        providerInstanceKey,
        surfaceKey: key,
        digest,
      }),
    ),
  });
}

export const attemptBaselineV2 = z
  .strictObject({
    schemaVersion: z.literal(2),
    expectedAgentManifestId: canonicalUuid,
    expectedAgentManifestDigest: sha256Digest,
    expectedAgentManifest: expectedAgentManifestV2,
    dependencyManifest: dependencyManifestV2,
  })
  .refine(
    (value) =>
      value.expectedAgentManifestDigest === agentManifestDigestV2(value.expectedAgentManifest),
    "Expected agent manifest digest does not match its immutable contents",
  )
  .refine((value) => {
    const catalogs = value.expectedAgentManifest.catalogs;
    const helpers = value.expectedAgentManifest.helperConfigurations;
    const surfaces = value.dependencyManifest.providers.flatMap((provider) =>
      provider.surfaces.map((surface) => ({
        ...surface,
        providerInstanceKey: provider.providerInstanceKey,
      })),
    );
    if (catalogs.length + helpers.length !== surfaces.length) return false;
    return surfaces.every((surface) =>
      surface.catalogDigest !== null
        ? catalogs.some(
            (entry) =>
              entry.providerInstanceKey === surface.providerInstanceKey &&
              entry.surfaceKey === surface.surfaceKey &&
              entry.digest === surface.catalogDigest &&
              entry.minimumEvidence === "observed",
          )
        : helpers.some(
            (entry) =>
              entry.providerInstanceKey === surface.providerInstanceKey &&
              entry.surfaceKey === surface.surfaceKey &&
              entry.digest === surface.helperConfigurationDigest,
          ),
    );
  }, "Selected MCP/native surfaces require exactly their matching catalog/helper evidence");
export type AttemptBaselineV2 = z.infer<typeof attemptBaselineV2>;

export const prepareAttemptInputV2 = z.strictObject({
  schemaVersion: z.literal(2),
  idempotencyKey: canonicalUuid,
  executionId: canonicalUuid,
  environmentRunId: canonicalUuid,
  expectedAgentManifestDigest: sha256Digest,
  actualManifest: actualAgentManifestV2,
  requestedProviders: z
    .array(
      z.strictObject({
        providerInstanceKey,
        surfaceKeys: z
          .array(surfaceKey)
          .min(1)
          .max(4)
          .refine((items) => unique(items, (item) => item)),
      }),
    )
    .min(1)
    .max(16)
    .refine((items) => unique(items, (item) => item.providerInstanceKey)),
});
export type PrepareAttemptInputV2 = z.infer<typeof prepareAttemptInputV2>;
export type PrepareAttemptRequestV2 = z.input<typeof prepareAttemptInputV2>;
export type RequestedAttemptProviderV2 = PrepareAttemptInputV2["requestedProviders"][number];

const findingMessagesV2 = {
  baseline_missing: "The immutable attempt baseline is unavailable.",
  baseline_assertion_mismatch:
    "The asserted expected agent manifest does not match the experiment baseline.",
  manifest_mismatch: "The actual agent manifest does not match the experiment baseline.",
  evidence_missing: "Required parity evidence is missing.",
  evidence_insufficient:
    "The supplied parity evidence does not meet the required provenance level.",
  helper_configuration_mismatch:
    "The native helper configuration or its order does not match the baseline.",
  catalog_mismatch: "The effective provider catalog or its order does not match the baseline.",
  provider_selection_mismatch: "The requested provider surfaces do not match the baseline.",
  profile_unavailable: "The pinned provider profile is unavailable.",
  profile_mismatch: "The resolved provider profile does not match the immutable pins.",
  surface_unsupported: "A selected provider surface is not supported by this runtime.",
  coverage_gap: "The pinned workflow is not covered by the provider profile.",
} as const;
const findingCodeV2 = z.enum(
  Object.keys(findingMessagesV2) as [
    keyof typeof findingMessagesV2,
    ...(keyof typeof findingMessagesV2)[],
  ],
);
export const preflightFindingV2 = z
  .strictObject({
    code: findingCodeV2,
    component: componentKey.nullable(),
    providerInstanceKey: providerInstanceKey.nullable(),
    surfaceKey: surfaceKey.nullable(),
    message: z.string(),
  })
  .refine((value) => value.message === findingMessagesV2[value.code]);
export type PreflightFindingV2 = z.infer<typeof preflightFindingV2>;

export const preflightReportV2 = z
  .strictObject({
    schemaVersion: z.literal(2),
    status: z.enum(["ready", "environment_incomplete"]),
    evidenceSource: z.literal("caller_supplied"),
    findings: z.array(preflightFindingV2).max(256),
  })
  .refine((value) => (value.status === "ready") === (value.findings.length === 0));
export type PreflightReportV2 = z.infer<typeof preflightReportV2>;

export const parityEvidenceV2 = z.strictObject({
  expectedAgentManifestId: canonicalUuid,
  expectedAgentManifestDigest: sha256Digest,
  actualAgentManifestDigest: sha256Digest,
  actualManifest: actualAgentManifestV2,
  dependencyManifestDigest: sha256Digest,
  executionManifestDigest: sha256Digest,
  evidenceSource: z.literal("caller_supplied"),
});
export type ParityEvidenceV2 = z.infer<typeof parityEvidenceV2>;

function isSafeHttpsEndpoint(value: string): boolean {
  if (!/^https:\/\//i.test(value) || /[\s\\?#]/u.test(value)) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  const afterScheme = value.slice(8);
  const pathStart = afterScheme.indexOf("/");
  const authority = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart);
  if (!authority || authority.includes("@")) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !!parsed.hostname &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}
const endpoint = z.string().refine(isSafeHttpsEndpoint);
const credentials = { endpoint, bearer: z.string().regex(/^[A-Za-z0-9_.-]{32,2048}$/) };
const connectionSurfaceV2 = z.discriminatedUnion("surfaceKey", [
  mcpSurfaceV2.extend(credentials),
  nativeSurfaceV2.extend(credentials),
]);
const connectionProviderV2 = z
  .strictObject({
    ...providerFieldsV2,
    surfaces: z
      .array(connectionSurfaceV2)
      .min(1)
      .max(4)
      .refine(
        (items) => unique(items, (item) => item.surfaceKey),
        "Selected surfaces must be unique",
      ),
  })
  .refine(validProviderV2);

export const attemptIdentityV2 = z.strictObject({
  bindingId: canonicalUuid,
  executionId: canonicalUuid,
  environmentRunId: canonicalUuid,
});
export type AttemptIdentityV2 = z.infer<typeof attemptIdentityV2>;

function connectionDependenciesV2(bundle: { providers: z.infer<typeof connectionProviderV2>[] }) {
  return {
    schemaVersion: 2 as const,
    providers: bundle.providers.map((provider) => ({
      ...provider,
      surfaces: provider.surfaces.map(
        ({
          surfaceRegistrationId: registrationId,
          surfaceKey: selectedSurfaceKey,
          protocolVersion,
          contractDigest,
          catalogDigest,
          helperConfigurationDigest,
          runtimeRegistrationDigest,
        }) => ({
          surfaceRegistrationId: registrationId,
          surfaceKey: selectedSurfaceKey,
          protocolVersion,
          contractDigest,
          catalogDigest,
          helperConfigurationDigest,
          runtimeRegistrationDigest,
        }),
      ),
    })),
  };
}

export function executionManifestDigestV2(
  actualManifest: ActualAgentManifestV2,
  dependencyManifest: DependencyManifestV2,
  identity: AttemptIdentityV2,
): string {
  return canonicalDigest({
    schemaVersion: 2,
    actualManifest: actualAgentManifestV2.parse(actualManifest),
    dependencyManifest: dependencyManifestV2.parse(dependencyManifest),
    identity: attemptIdentityV2.parse(identity),
  });
}

export const attemptConnectionBundleV2 = z
  .strictObject({
    schemaVersion: z.literal(2),
    bindingId: canonicalUuid,
    executionId: canonicalUuid,
    environmentRunId: canonicalUuid,
    expiresAt: z.iso.datetime(),
    credentialGeneration: z.number().int().min(0).max(2_147_483_647),
    providers: z
      .array(connectionProviderV2)
      .min(1)
      .max(16)
      .refine(
        (items) => unique(items, (item) => item.providerInstanceKey),
        "Provider instances must be unique",
      ),
    parity: parityEvidenceV2,
  })
  .refine((bundle) => {
    const dependencies = dependencyManifestV2.safeParse(connectionDependenciesV2(bundle));
    if (!dependencies.success) return false;
    return (
      bundle.parity.actualAgentManifestDigest ===
        agentManifestDigestV2(bundle.parity.actualManifest) &&
      bundle.parity.expectedAgentManifestDigest === bundle.parity.actualAgentManifestDigest &&
      bundle.parity.dependencyManifestDigest === canonicalDigest(dependencies.data) &&
      bundle.parity.executionManifestDigest ===
        executionManifestDigestV2(bundle.parity.actualManifest, dependencies.data, {
          bindingId: bundle.bindingId,
          executionId: bundle.executionId,
          environmentRunId: bundle.environmentRunId,
        })
    );
  }, "Bundle evidence must match its immutable contents and attempt identity");
export type AttemptConnectionBundleV2 = z.infer<typeof attemptConnectionBundleV2>;

export function secretFreeBindingV2(bundle: AttemptConnectionBundleV2): DependencyManifestV2 {
  return dependencyManifestV2.parse(connectionDependenciesV2(bundle));
}

/** Legacy context.mcp is a credential-bearing projection, never another source of binding truth. */
export function projectMcpConnectionV2(bundle: AttemptConnectionBundleV2, instanceKey: string) {
  const surface = bundle.providers
    .find((provider) => provider.providerInstanceKey === instanceKey)
    ?.surfaces.find((candidate) => candidate.surfaceKey.endsWith("/mcp"));
  return surface
    ? { url: surface.endpoint, token: surface.bearer, expiresAt: bundle.expiresAt }
    : null;
}

const actualAgentManifestV1 = z
  .strictObject({
    schemaVersion: z.literal(1).default(1),
    components,
    catalogs: z
      .array(
        z
          .strictObject({
            providerInstanceKey,
            surfaceKey,
            digest: sha256Digest.nullable(),
            evidence,
          })
          .refine((value) => (value.evidence === "missing") === (value.digest === null)),
      )
      .max(64)
      .refine((items) => unique(items, (item) => `${item.providerInstanceKey}/${item.surfaceKey}`))
      .default(() => []),
  })
  .default(() => ({ schemaVersion: 1 as const, components: missingComponents(), catalogs: [] }));
const surfaceBindingV1 = z.strictObject({
  surfaceRegistrationId,
  surfaceKey,
  protocolVersion: z.string().regex(/^[a-zA-Z0-9._/+-]{1,64}$/),
  contractDigest: sha256Digest,
  catalogDigest: sha256Digest,
});
const profilePinsV1 = z.strictObject({
  profileId: z.string().regex(/^[a-z][a-z0-9._/-]{0,127}$/),
  profileDigest: sha256Digest,
  buildDigest: sha256Digest,
  coverageDigest: sha256Digest,
  contractDigests: z
    .array(z.strictObject({ surfaceKey, contractDigest: sha256Digest }))
    .min(1)
    .max(4)
    .refine((items) => sorted(items, (item) => item.surfaceKey)),
});
const dependencyProviderV1Base = z.strictObject({
  providerInstanceKey,
  providerId: z.enum(["google.gmail", "slack"]),
  syntheticPrincipalId: canonicalUuid,
  scopes: z
    .array(z.string().regex(/^[a-zA-Z0-9._:/-]{1,256}$/))
    .max(64)
    .refine((items) => sorted(items, (item) => item)),
  profile: profilePinsV1,
  workflowDigest: sha256Digest,
  surfaces: z
    .array(surfaceBindingV1)
    .min(1)
    .max(4)
    .refine((items) => unique(items, (item) => item.surfaceKey)),
});
const dependencyProviderV1 = dependencyProviderV1Base.refine(
  (value) =>
    value.profile.contractDigests.every((item) =>
      item.surfaceKey.startsWith(`${value.providerId}/`),
    ) &&
    value.surfaces.every(
      (item) =>
        item.surfaceKey.startsWith(`${value.providerId}/`) &&
        value.profile.contractDigests.some(
          (contract) =>
            contract.surfaceKey === item.surfaceKey &&
            contract.contractDigest === item.contractDigest,
        ),
    ),
);
const dependencyManifestV1 = z.strictObject({
  schemaVersion: z.literal(1),
  providers: z
    .array(dependencyProviderV1)
    .min(1)
    .max(16)
    .refine((items) => unique(items, (item) => item.providerInstanceKey)),
});
const findingMessagesV1 = {
  baseline_missing: findingMessagesV2.baseline_missing,
  baseline_assertion_mismatch: findingMessagesV2.baseline_assertion_mismatch,
  manifest_mismatch: findingMessagesV2.manifest_mismatch,
  evidence_missing: findingMessagesV2.evidence_missing,
  evidence_insufficient: findingMessagesV2.evidence_insufficient,
  catalog_mismatch: findingMessagesV2.catalog_mismatch,
  provider_selection_mismatch: findingMessagesV2.provider_selection_mismatch,
  profile_unavailable: findingMessagesV2.profile_unavailable,
  profile_mismatch: findingMessagesV2.profile_mismatch,
  surface_unsupported: findingMessagesV2.surface_unsupported,
  coverage_gap: findingMessagesV2.coverage_gap,
} as const;
const findingCodeV1 = z.enum(
  Object.keys(findingMessagesV1) as [
    keyof typeof findingMessagesV1,
    ...(keyof typeof findingMessagesV1)[],
  ],
);
const preflightFindingV1 = z
  .strictObject({
    code: findingCodeV1,
    component: componentKey.nullable(),
    providerInstanceKey: providerInstanceKey.nullable(),
    surfaceKey: surfaceKey.nullable(),
    message: z.string(),
  })
  .refine((value) => value.message === findingMessagesV1[value.code]);
const preflightReportV1 = z
  .strictObject({
    schemaVersion: z.literal(1),
    status: z.enum(["ready", "environment_incomplete"]),
    evidenceSource: z.literal("caller_supplied"),
    findings: z.array(preflightFindingV1).max(256),
  })
  .refine((value) => (value.status === "ready") === (value.findings.length === 0));

const bindingReadFields = {
  bindingId: canonicalUuid,
  executionId: canonicalUuid,
  environmentRunId: canonicalUuid,
  outcome: z.enum(["ready", "environment_incomplete"]),
  credentialGeneration: z.number().int().min(0).max(2_147_483_647).nullable(),
  expectedAgentManifestId: canonicalUuid.nullable(),
  expectedAgentManifestDigest: sha256Digest.nullable(),
  executionManifestDigest: sha256Digest.nullable(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
};
const attemptBindingReadV1 = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...bindingReadFields,
    actualManifest: actualAgentManifestV1,
    dependencyManifest: dependencyManifestV1.nullable(),
    preflightReport: preflightReportV1,
  })
  .refine((value) => value.outcome === value.preflightReport.status);
const attemptBindingReadV2 = z
  .strictObject({
    schemaVersion: z.literal(2),
    ...bindingReadFields,
    actualManifest: actualAgentManifestV2,
    dependencyManifest: dependencyManifestV2.nullable(),
    preflightReport: preflightReportV2,
  })
  .refine((value) => value.outcome === value.preflightReport.status);
export const attemptBindingRead = z.union([attemptBindingReadV1, attemptBindingReadV2]);
export type AttemptBindingRead = z.infer<typeof attemptBindingRead>;

export type PrepareAttemptReadyV2 = {
  status: "ready";
  preflightReport: PreflightReportV2 & { status: "ready" };
  bundle: AttemptConnectionBundleV2;
};
export type PrepareAttemptIncompleteV2 = {
  status: "environment_incomplete";
  bindingId: string;
  preflightReport: PreflightReportV2 & { status: "environment_incomplete" };
  gap: CoverageGap;
};
export type PrepareAttemptResultV2 = PrepareAttemptReadyV2 | PrepareAttemptIncompleteV2;
export type RefreshAttemptResultV2 = PrepareAttemptReadyV2;
export type RevokeAttemptResult = { bindingId: string; revokedAt: string };

function parseGap(value: unknown): CoverageGap {
  const source = z
    .strictObject({
      provider: z.string().min(1).max(128),
      operation: z.string().min(1).max(256),
      code: z.string().min(1).max(128),
      args: z.record(z.string(), z.unknown()),
      description: z.string().min(1).max(2000),
      reportedAt: z.iso.datetime(),
      reportedBy: z.strictObject({
        kind: z.enum(["project_key", "user"]),
        id: canonicalUuid,
      }),
    })
    .parse(value);
  return {
    ...source,
    args: json(source.args, { ...valueBounds, bytes: 16_000 }) as Record<string, JsonValue>,
  };
}

function requireFresh(bundle: AttemptConnectionBundleV2): AttemptConnectionBundleV2 {
  if (Date.parse(bundle.expiresAt) <= Date.now()) throw new TypeError("Expired attempt connection");
  return bundle;
}

export function validateAttemptConnectionBundleV2(
  value: unknown,
  options: { requireFresh?: boolean } = {},
): AttemptConnectionBundleV2 {
  const bundle = attemptConnectionBundleV2.parse(value);
  return options.requireFresh ? requireFresh(bundle) : bundle;
}

function selectedProviders(bundle: AttemptConnectionBundleV2) {
  return bundle.providers.map((provider) => ({
    providerInstanceKey: provider.providerInstanceKey,
    surfaceKeys: provider.surfaces.map((surface) => surface.surfaceKey),
  }));
}

export function parsePrepareAttemptResultV2(
  value: unknown,
  expected: PrepareAttemptInputV2,
): PrepareAttemptResultV2 {
  if (
    value &&
    typeof value === "object" &&
    (value as { status?: unknown }).status === "environment_incomplete"
  ) {
    const result = z
      .strictObject({
        status: z.literal("environment_incomplete"),
        bindingId: canonicalUuid,
        preflightReport: preflightReportV2,
        gap: z.unknown(),
      })
      .parse(value);
    if (result.preflightReport.status !== "environment_incomplete")
      throw new TypeError("Invalid attempt preflight result");
    const gap = parseGap(result.gap);
    if (gap.provider === "hue.attempt") {
      if (
        gap.operation !== "prepare_attempt" ||
        gap.code !== "attempt_preflight_incomplete" ||
        gap.description !== "Attempt preflight could not establish the required simulation parity."
      )
        throw new TypeError("Invalid attempt coverage gap");
      const args = z
        .strictObject({ findingCodes: z.array(findingCodeV2).max(11) })
        .refine((item) => unique(item.findingCodes, (code) => code))
        .parse(gap.args);
      const expectedCodes = [
        ...new Set(result.preflightReport.findings.map((finding) => finding.code)),
      ];
      if (canonicalDigest(args.findingCodes) !== canonicalDigest(expectedCodes))
        throw new TypeError("Invalid attempt finding evidence");
    } else if (
      !result.preflightReport.findings.some((finding) => finding.code === "coverage_gap")
    ) {
      throw new TypeError("Invalid preserved coverage gap");
    }
    return {
      status: "environment_incomplete",
      bindingId: result.bindingId,
      preflightReport: { ...result.preflightReport, status: "environment_incomplete" },
      gap,
    };
  }
  const result = z
    .strictObject({
      status: z.literal("ready"),
      preflightReport: preflightReportV2,
      bundle: attemptConnectionBundleV2,
    })
    .parse(value);
  if (result.preflightReport.status !== "ready")
    throw new TypeError("Invalid attempt preflight result");
  const bundle = requireFresh(result.bundle);
  if (
    bundle.executionId !== expected.executionId ||
    bundle.environmentRunId !== expected.environmentRunId ||
    bundle.parity.expectedAgentManifestDigest !== expected.expectedAgentManifestDigest ||
    canonicalDigest(bundle.parity.actualManifest) !== canonicalDigest(expected.actualManifest) ||
    canonicalDigest(selectedProviders(bundle)) !== canonicalDigest(expected.requestedProviders)
  )
    throw new TypeError("Attempt connection does not match its request");
  return {
    status: "ready",
    preflightReport: { ...result.preflightReport, status: "ready" },
    bundle,
  };
}

function stableBundleEvidence(bundle: AttemptConnectionBundleV2) {
  return {
    schemaVersion: bundle.schemaVersion,
    bindingId: bundle.bindingId,
    executionId: bundle.executionId,
    environmentRunId: bundle.environmentRunId,
    dependencyManifest: secretFreeBindingV2(bundle),
    parity: bundle.parity,
  };
}

export function parseRefreshedAttemptResultV2(
  value: unknown,
  previous: AttemptConnectionBundleV2,
): RefreshAttemptResultV2 {
  const trustedPrevious = attemptConnectionBundleV2.parse(previous);
  const result = z
    .strictObject({
      status: z.literal("ready"),
      preflightReport: preflightReportV2,
      bundle: attemptConnectionBundleV2,
    })
    .parse(value);
  const bundle = requireFresh(result.bundle);
  if (
    result.preflightReport.status !== "ready" ||
    bundle.credentialGeneration !== trustedPrevious.credentialGeneration + 1 ||
    canonicalDigest(stableBundleEvidence(bundle)) !==
      canonicalDigest(stableBundleEvidence(trustedPrevious))
  )
    throw new TypeError("Refreshed attempt connection changed immutable evidence");
  return {
    status: "ready",
    preflightReport: { ...result.preflightReport, status: "ready" },
    bundle,
  };
}

export function parseRevocationResult(
  value: unknown,
  expectedBindingId: string,
): RevokeAttemptResult {
  const result = z
    .strictObject({ bindingId: canonicalUuid, revokedAt: z.iso.datetime() })
    .parse(value);
  if (result.bindingId !== canonicalUuid.parse(expectedBindingId))
    throw new TypeError("Revoked attempt identity changed");
  return result;
}
