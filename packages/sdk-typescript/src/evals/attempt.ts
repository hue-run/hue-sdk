import { createHash } from "node:crypto";
import { z } from "zod";
import type { CoverageGap } from "../environment/types.js";
import type { JsonValue, SimulationMcpCapability } from "./types.js";
import { json, valueBounds } from "./json.js";

/** Canonical caller-observed agent configuration after missing evidence is made explicit. */
export type ActualAgentManifestV2 = {
  /** Manifest schema discriminator. */
  schemaVersion: 2;
  /** Digests for the six strict parity components. */
  components: {
    /** Agent implementation identity. */
    agent: {
      /** Canonical SHA-256 digest, or `null` when the evidence is missing. */
      digest: string | null;
      /** How the caller obtained the digest. */
      evidence: "observed" | "declared" | "missing";
    };
    /** Prompt identity. */
    prompt: ActualAgentManifestV2["components"]["agent"];
    /** Model configuration identity. */
    model: ActualAgentManifestV2["components"]["agent"];
    /** Effective tool configuration identity. */
    tools: ActualAgentManifestV2["components"]["agent"];
    /** Approval-policy identity. */
    approvals: ActualAgentManifestV2["components"]["agent"];
    /** Orchestration identity. */
    orchestration: ActualAgentManifestV2["components"]["agent"];
  };
  /** MCP catalogs in effective model-visible order; this array is never sorted. */
  catalogs: Array<{
    /** Caller-selected provider instance. */
    providerInstanceKey: string;
    /** MCP surface whose catalog was observed or declared. */
    surfaceKey: "google.gmail/mcp" | "slack/mcp";
    /** Catalog digest, or `null` when missing. */
    digest: string | null;
    /** How the caller obtained the digest. */
    evidence: "observed" | "declared" | "missing";
  }>;
  /** Native helper configurations in their effective order. */
  helperConfigurations: Array<{
    /** Caller-selected provider instance. */
    providerInstanceKey: string;
    /** Native provider surface whose helper configuration is described. */
    surfaceKey: "google.gmail/rest" | "slack/web-api";
    /** Helper-configuration digest, or `null` when missing. */
    digest: string | null;
    /** How the caller obtained the digest. */
    evidence: "observed" | "declared" | "missing";
  }>;
};

/** Input form of {@link ActualAgentManifestV2}; omitted evidence normalizes to missing. */
export type ActualAgentManifestInputV2 =
  | {
      /** Optional schema assertion; when present it must be V2. */
      schemaVersion?: 2;
      /** Any omitted component is recorded as missing. */
      components?: Partial<ActualAgentManifestV2["components"]>;
      /** MCP catalogs in effective model-visible order. */
      catalogs?: ActualAgentManifestV2["catalogs"];
      /** Native helper configurations in effective order. */
      helperConfigurations?: ActualAgentManifestV2["helperConfigurations"];
    }
  | undefined;

/** Immutable expected agent evidence pinned by an experiment. */
export type ExpectedAgentManifestV2 = {
  /** Manifest schema discriminator. */
  schemaVersion: 2;
  /** Required digests and minimum provenance for all strict components. */
  components: {
    /** Agent implementation requirement. */
    agent: {
      /** Canonical SHA-256 digest pinned by the experiment. */
      digest: string;
      /** Weakest provenance the caller may supply. */
      minimumEvidence: "observed" | "declared";
    };
    /** Prompt requirement. */
    prompt: ExpectedAgentManifestV2["components"]["agent"];
    /** Model configuration requirement. */
    model: ExpectedAgentManifestV2["components"]["agent"];
    /** Effective tool configuration requirement. */
    tools: ExpectedAgentManifestV2["components"]["agent"];
    /** Approval-policy requirement. */
    approvals: ExpectedAgentManifestV2["components"]["agent"];
    /** Orchestration requirement. */
    orchestration: ExpectedAgentManifestV2["components"]["agent"];
  };
  /** Required MCP catalogs in effective model-visible order. */
  catalogs: Array<{
    /** Pinned provider instance. */
    providerInstanceKey: string;
    /** Pinned MCP surface. */
    surfaceKey: "google.gmail/mcp" | "slack/mcp";
    /** Expected catalog digest. */
    digest: string;
    /** Weakest accepted provenance for this catalog. */
    minimumEvidence: "observed" | "declared";
  }>;
  /** Required native helper configurations in effective order. */
  helperConfigurations: Array<{
    /** Pinned provider instance. */
    providerInstanceKey: string;
    /** Pinned native surface. */
    surfaceKey: "google.gmail/rest" | "slack/web-api";
    /** Expected helper-configuration digest. */
    digest: string;
    /** Weakest accepted provenance for this helper configuration. */
    minimumEvidence: "observed" | "declared";
  }>;
};

/** Secret-free registration identity for one selected provider surface. */
export type SurfaceBindingV2 =
  | {
      /** Factory-issued registration identity. */
      surfaceRegistrationId: string;
      /** Selected MCP surface. */
      surfaceKey: "google.gmail/mcp" | "slack/mcp";
      /** Provider protocol revision. */
      protocolVersion: string;
      /** Agent-visible contract digest. */
      contractDigest: string;
      /** Effective MCP catalog digest. */
      catalogDigest: string;
      /** Native helper evidence is inapplicable to MCP. */
      helperConfigurationDigest: null;
      /** Runtime registration implementation digest. */
      runtimeRegistrationDigest: string;
    }
  | {
      /** Factory-issued registration identity. */
      surfaceRegistrationId: string;
      /** Selected native provider surface. */
      surfaceKey: "google.gmail/rest" | "slack/web-api";
      /** Provider protocol revision. */
      protocolVersion: string;
      /** Agent-visible contract digest. */
      contractDigest: string;
      /** MCP catalog evidence is inapplicable to native surfaces. */
      catalogDigest: null;
      /** Effective native helper-configuration digest. */
      helperConfigurationDigest: string;
      /** Runtime registration implementation digest. */
      runtimeRegistrationDigest: string;
    };

/** One provider instance and its immutable profile/surface pins. */
export type DependencyProviderV2 = {
  /** Caller-visible provider instance key. */
  providerInstanceKey: string;
  /** Provider family. */
  providerId: "google.gmail" | "slack";
  /** Synthetic principal bound to this world. */
  syntheticPrincipalId: string;
  /** Sorted scopes granted to the synthetic principal. */
  scopes: string[];
  /** Immutable profile identity and coverage pins. */
  profile: {
    /** Versioned profile identifier. */
    profileId: string;
    /** Canonical profile digest. */
    profileDigest: string;
    /** Adapter build digest. */
    buildDigest: string;
    /** Covered-workflow digest. */
    coverageDigest: string;
    /** Contract digests sorted by surface key. */
    contractDigests: Array<{
      /** Surface described by the contract. */
      surfaceKey: "google.gmail/mcp" | "google.gmail/rest" | "slack/mcp" | "slack/web-api";
      /** Agent-visible contract digest. */
      contractDigest: string;
    }>;
  };
  /** Digest of the supported provider workflow slice. */
  workflowDigest: string;
  /** Selected, secret-free surface bindings. */
  surfaces: SurfaceBindingV2[];
};

/** Secret-free dependency manifest pinned to one attempt. */
export type DependencyManifestV2 = {
  /** Manifest schema discriminator. */
  schemaVersion: 2;
  /** Uniquely keyed provider instances sharing the same world. */
  providers: DependencyProviderV2[];
};

/** Immutable V2 parity and provider baseline stored with an experiment version. */
export type AttemptBaselineV2 = {
  /** Baseline schema discriminator. */
  schemaVersion: 2;
  /** Immutable expected-manifest identity. */
  expectedAgentManifestId: string;
  /** Digest of the expected manifest. */
  expectedAgentManifestDigest: string;
  /** Full expected agent evidence. */
  expectedAgentManifest: ExpectedAgentManifestV2;
  /** Secret-free provider dependencies. */
  dependencyManifest: DependencyManifestV2;
};

/** Exact provider instance and surface selection requested for an attempt. */
export type RequestedAttemptProviderV2 = {
  /** Provider instance pinned by the baseline. */
  providerInstanceKey: string;
  /** Selected surface keys in effective order. */
  surfaceKeys: Array<"google.gmail/mcp" | "google.gmail/rest" | "slack/mcp" | "slack/web-api">;
};

/** Canonical V2 prepare input after defaulting caller evidence. */
export type PrepareAttemptInputV2 = {
  /** Request schema discriminator. */
  schemaVersion: 2;
  /** Stable idempotency key for this preparation decision. */
  idempotencyKey: string;
  /** Execution identity inserted into the route, not the JSON body. */
  executionId: string;
  /** Isolated world bound to the execution. */
  environmentRunId: string;
  /** Stale-client assertion for the experiment's expected manifest. */
  expectedAgentManifestDigest: string;
  /** Caller-observed agent evidence with missing fields made explicit. */
  actualManifest: ActualAgentManifestV2;
  /** Exact provider/surface selection. */
  requestedProviders: RequestedAttemptProviderV2[];
};

/** Caller input to {@link EvaluationClient.prepareAttempt}. */
export type PrepareAttemptRequestV2 = Omit<PrepareAttemptInputV2, "actualManifest"> & {
  /** Caller-observed evidence; omission records an all-missing V2 manifest. */
  actualManifest?: ActualAgentManifestInputV2;
};

/** One strict parity, profile, binding or coverage finding. */
export type PreflightFindingV2 = {
  /** Stable finding category. */
  code:
    | "baseline_missing"
    | "baseline_assertion_mismatch"
    | "manifest_mismatch"
    | "evidence_missing"
    | "evidence_insufficient"
    | "helper_configuration_mismatch"
    | "catalog_mismatch"
    | "provider_selection_mismatch"
    | "profile_unavailable"
    | "profile_mismatch"
    | "surface_unsupported"
    | "coverage_gap";
  /** Agent component involved, when applicable. */
  component: "agent" | "prompt" | "model" | "tools" | "approvals" | "orchestration" | null;
  /** Provider instance involved, when applicable. */
  providerInstanceKey: string | null;
  /** Provider surface involved, when applicable. */
  surfaceKey: "google.gmail/mcp" | "google.gmail/rest" | "slack/mcp" | "slack/web-api" | null;
  /** Fixed nonsecret explanation for the finding code. */
  message: string;
};

/** Credential-free V2 preflight decision. */
export type PreflightReportV2 = {
  /** Report schema discriminator. */
  schemaVersion: 2;
  /** Whether strict preflight succeeded. */
  status: "ready" | "environment_incomplete";
  /** Provenance class for the actual manifest. */
  evidenceSource: "caller_supplied";
  /** Empty for ready; otherwise the bounded reasons the environment is incomplete. */
  findings: PreflightFindingV2[];
};

/** Stable parity evidence stored without endpoints or credentials. */
export type ParityEvidenceV2 = {
  /** Immutable expected-manifest identity. */
  expectedAgentManifestId: string;
  /** Expected manifest digest asserted by the request. */
  expectedAgentManifestDigest: string;
  /** Canonical digest of the caller-observed manifest. */
  actualAgentManifestDigest: string;
  /** Caller-observed manifest used for preflight. */
  actualManifest: ActualAgentManifestV2;
  /** Digest of the secret-free dependency manifest. */
  dependencyManifestDigest: string;
  /** Digest binding agent evidence, dependencies and attempt identity. */
  executionManifestDigest: string;
  /** Provenance class for the actual manifest. */
  evidenceSource: "caller_supplied";
};

/** Stable identities shared by every credential generation of an attempt. */
export type AttemptIdentityV2 = {
  /** Prepared binding identity. */
  bindingId: string;
  /** Local target execution identity. */
  executionId: string;
  /** Isolated simulated-world identity. */
  environmentRunId: string;
};

/** Credential-bearing V2 provider connections delivered only to the callback. */
export type AttemptConnectionBundleV2 = AttemptIdentityV2 & {
  /** Bundle schema discriminator. */
  schemaVersion: 2;
  /** Expiry shared by every selected credential in this generation. */
  expiresAt: string;
  /** Monotonic credential generation; immutable evidence does not change on rotation. */
  credentialGeneration: number;
  /** Selected provider instances and their short-lived connection details. */
  providers: Array<
    Omit<DependencyProviderV2, "surfaces"> & {
      /** Selected surfaces with attempt-scoped connection material. */
      surfaces: Array<
        SurfaceBindingV2 & {
          /** HTTPS provider-facade endpoint. */
          endpoint: string;
          /** Short-lived attempt bearer; never persist or log it. */
          bearer: string;
        }
      >;
    }
  >;
  /** Credential-free evidence binding this connection to the strict preflight. */
  parity: ParityEvidenceV2;
};

/** Secret-free persisted binding state, discriminated without converting V1 evidence. */
export type AttemptBindingRead = {
  /** Stable binding identity. */
  bindingId: string;
  /** Bound execution identity. */
  executionId: string;
  /** Bound simulated-world identity. */
  environmentRunId: string;
  /** Persisted preflight outcome. */
  outcome: "ready" | "environment_incomplete";
  /** Last credential generation, or `null` when no live credential was issued. */
  credentialGeneration: number | null;
  /** Expected-manifest identity, or `null` for an incomplete legacy baseline. */
  expectedAgentManifestId: string | null;
  /** Expected-manifest digest, or `null` for an incomplete legacy baseline. */
  expectedAgentManifestDigest: string | null;
  /** Execution-manifest digest, or `null` when strict parity was not established. */
  executionManifestDigest: string | null;
  /** Binding creation timestamp. */
  createdAt: string;
  /** Revocation timestamp, or `null` while active. */
  revokedAt: string | null;
} & (
  | {
      /** Legacy evidence remains V1 and is never upgraded in place. */
      schemaVersion: 1;
      /** Legacy actual manifest without native-helper evidence. */
      actualManifest: Omit<
        ActualAgentManifestV2,
        "schemaVersion" | "catalogs" | "helperConfigurations"
      > & {
        /** Legacy manifest schema discriminator. */
        schemaVersion: 1;
        /** Legacy catalogs may refer to any V1 surface. */
        catalogs: Array<{
          /** Provider instance described by the catalog. */
          providerInstanceKey: string;
          /** Legacy provider surface. */
          surfaceKey: "google.gmail/mcp" | "google.gmail/rest" | "slack/mcp" | "slack/web-api";
          /** Catalog digest, or `null` when missing. */
          digest: string | null;
          /** How the caller obtained the digest. */
          evidence: "observed" | "declared" | "missing";
        }>;
      };
      /** Legacy secret-free dependency pins, or `null` for incomplete evidence. */
      dependencyManifest: null | {
        /** Legacy manifest schema discriminator. */
        schemaVersion: 1;
        /** Legacy provider dependencies. */
        providers: Array<
          Omit<DependencyProviderV2, "surfaces"> & {
            /** Legacy surfaces carried only a catalog digest. */
            surfaces: Array<{
              /** Factory-issued registration identity. */
              surfaceRegistrationId: string;
              /** Legacy selected surface. */
              surfaceKey: "google.gmail/mcp" | "google.gmail/rest" | "slack/mcp" | "slack/web-api";
              /** Provider protocol revision. */
              protocolVersion: string;
              /** Agent-visible contract digest. */
              contractDigest: string;
              /** Legacy catalog digest. */
              catalogDigest: string;
            }>;
          }
        >;
      };
      /** Coupled legacy preflight evidence. */
      preflightReport: Omit<PreflightReportV2, "schemaVersion" | "findings"> & {
        /** Legacy report schema discriminator. */
        schemaVersion: 1;
        /** Legacy findings do not include native-helper mismatch. */
        findings: Array<
          Omit<PreflightFindingV2, "code"> & {
            /** Legacy finding category. */
            code: Exclude<PreflightFindingV2["code"], "helper_configuration_mismatch">;
          }
        >;
      };
    }
  | {
      /** Current binding evidence schema. */
      schemaVersion: 2;
      /** Actual V2 agent evidence. */
      actualManifest: ActualAgentManifestV2;
      /** Secret-free V2 dependency pins, or `null` for incomplete evidence. */
      dependencyManifest: DependencyManifestV2 | null;
      /** Coupled V2 preflight evidence. */
      preflightReport: PreflightReportV2;
    }
);

/** Successful V2 preparation result with fresh callback-only credentials. */
export interface PrepareAttemptReadyV2 {
  /** Ready discriminator. */
  status: "ready";
  /** Finding-free preflight report. */
  preflightReport: PreflightReportV2 & {
    /** Ready discriminator narrowed from the report union. */
    status: "ready";
  };
  /** Fresh credential-bearing connection bundle. */
  bundle: AttemptConnectionBundleV2;
}

/** Inconclusive V2 preparation result; no target or scorer may run. */
export interface PrepareAttemptIncompleteV2 {
  /** Incomplete discriminator. */
  status: "environment_incomplete";
  /** Stable binding identity recorded with the gap. */
  bindingId: string;
  /** Preflight findings that prevented strict parity. */
  preflightReport: PreflightReportV2 & {
    /** Incomplete discriminator narrowed from the report union. */
    status: "environment_incomplete";
  };
  /** Durable first coverage/preflight gap on the world. */
  gap: CoverageGap;
}

/** Discriminated result of preparing one V2 attempt. */
export type PrepareAttemptResultV2 = PrepareAttemptReadyV2 | PrepareAttemptIncompleteV2;
/** Successful credential rotation; immutable binding evidence is unchanged. */
export type RefreshAttemptResultV2 = PrepareAttemptReadyV2;
/** Confirmation that one attempt binding was revoked. */
export interface RevokeAttemptResult {
  /** Revoked binding identity. */
  bindingId: string;
  /** Server timestamp of revocation. */
  revokedAt: string;
}

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

/** Runtime validator for the caller-observed V2 agent manifest supplied before target execution. */
export const actualAgentManifestV2: z.ZodType<ActualAgentManifestV2, ActualAgentManifestInputV2> = z
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
/** Runtime validator for the immutable expected V2 agent manifest. */
export const expectedAgentManifestV2: z.ZodType<ExpectedAgentManifestV2> = z.strictObject({
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
/** Runtime validator for one secret-free V2 surface binding. */
export const surfaceBindingV2: z.ZodType<SurfaceBindingV2> = z.discriminatedUnion("surfaceKey", [
  mcpSurfaceV2,
  nativeSurfaceV2,
]);
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
/** Runtime validator for one V2 provider dependency. */
export const dependencyProviderV2: z.ZodType<DependencyProviderV2> = providerBaseV2.refine(
  validProviderV2,
  "Selected surface contracts must match the pinned profile and provider",
);
/** Runtime validator for the secret-free V2 dependency manifest. */
export const dependencyManifestV2: z.ZodType<DependencyManifestV2> = z.strictObject({
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

/** Computes the canonical digest shared by actual and expected V2 agent manifests. */
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

/** Runtime validator for an immutable V2 experiment baseline. */
export const attemptBaselineV2: z.ZodType<AttemptBaselineV2> = z
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
/** Internal parser reused by `runSimulation` before an execution exists. */
export const requestedAttemptProvidersV2: z.ZodType<
  RequestedAttemptProviderV2[],
  RequestedAttemptProviderV2[]
> = z
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
  .refine((items) => unique(items, (item) => item.providerInstanceKey));

/** Runtime validator for the full V2 prepare input, including its route identity. */
export const prepareAttemptInputV2: z.ZodType<PrepareAttemptInputV2, PrepareAttemptRequestV2> =
  z.strictObject({
    schemaVersion: z.literal(2),
    idempotencyKey: canonicalUuid,
    executionId: canonicalUuid,
    environmentRunId: canonicalUuid,
    expectedAgentManifestDigest: sha256Digest,
    actualManifest: actualAgentManifestV2,
    requestedProviders: requestedAttemptProvidersV2,
  });
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
/** Runtime validator for one V2 preflight finding. */
export const preflightFindingV2: z.ZodType<PreflightFindingV2> = z
  .strictObject({
    code: findingCodeV2,
    component: componentKey.nullable(),
    providerInstanceKey: providerInstanceKey.nullable(),
    surfaceKey: surfaceKey.nullable(),
    message: z.string(),
  })
  .refine((value) => value.message === findingMessagesV2[value.code]);
/** Runtime validator for the V2 preflight report. */
export const preflightReportV2: z.ZodType<PreflightReportV2> = z
  .strictObject({
    schemaVersion: z.literal(2),
    status: z.enum(["ready", "environment_incomplete"]),
    evidenceSource: z.literal("caller_supplied"),
    findings: z.array(preflightFindingV2).max(256),
  })
  .refine((value) => (value.status === "ready") === (value.findings.length === 0));
/** Runtime validator for stable, credential-free V2 parity evidence. */
export const parityEvidenceV2: z.ZodType<ParityEvidenceV2> = z.strictObject({
  expectedAgentManifestId: canonicalUuid,
  expectedAgentManifestDigest: sha256Digest,
  actualAgentManifestDigest: sha256Digest,
  actualManifest: actualAgentManifestV2,
  dependencyManifestDigest: sha256Digest,
  executionManifestDigest: sha256Digest,
  evidenceSource: z.literal("caller_supplied"),
});
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

/** Runtime validator for the stable V2 attempt identity. */
export const attemptIdentityV2: z.ZodType<AttemptIdentityV2> = z.strictObject({
  bindingId: canonicalUuid,
  executionId: canonicalUuid,
  environmentRunId: canonicalUuid,
});
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

/** Binds actual agent evidence, secret-free dependencies and stable attempt identities. */
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

/** Runtime validator for a credential-bearing V2 connection bundle. */
export const attemptConnectionBundleV2: z.ZodType<AttemptConnectionBundleV2> = z
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
/** Removes endpoints and bearers from a validated bundle, retaining its dependency identity. */
export function secretFreeBindingV2(bundle: AttemptConnectionBundleV2): DependencyManifestV2 {
  return dependencyManifestV2.parse(connectionDependenciesV2(bundle));
}

/** Legacy context.mcp is a credential-bearing projection, never another source of binding truth. */
export function projectMcpConnectionV2(
  bundle: AttemptConnectionBundleV2,
  instanceKey: string,
): SimulationMcpCapability | null {
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
/** Runtime validator for a coupled, secret-free V1 or V2 binding read. */
export const attemptBindingRead: z.ZodType<AttemptBindingRead> = z.union([
  attemptBindingReadV1,
  attemptBindingReadV2,
]);
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
