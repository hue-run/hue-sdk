import type { JsonValue, McpServerInfo } from "../types.js";

export type { JsonValue } from "../types.js";

/** Human-readable identity used when creating an environment. */
export interface EnvironmentIdentity {
  /** Display name. */
  name: string;
  /** Project-unique URL-safe slug. */
  slug: string;
  /** Optional description of the simulated world. */
  description?: string;
}
/** Environment registry entry without version bodies. */
export interface EnvironmentSummary extends Required<EnvironmentIdentity> {
  /** Environment identity. */
  id: string;
  /** Archive timestamp, or `null` while active. */
  archivedAt: string | null;
}
/** Immutable environment-version identity. */
export interface EnvironmentVersionSummary {
  /** Environment-version identity. */
  id: string;
  /** Monotonic version number within the environment. */
  version: number;
  /** Canonical digest of the stored, defaulted definition. */
  contentDigest: string;
  /** Creation timestamp. */
  createdAt: string;
}
/** Environment registry entry with all immutable versions. */
export interface Environment extends EnvironmentSummary {
  /** Versions available for explicit pinning. */
  versions: EnvironmentVersionSummary[];
}
/** One page of environment registry entries. */
export interface EnvironmentPage {
  /** Entries on this page. */
  items: EnvironmentSummary[];
  /** Cursor for the next page, or `null` at the end. */
  nextCursor: string | null;
}
/** Cursor pagination for environment registry methods. */
export interface EnvironmentPageOptions {
  /** Cursor returned by the previous page. */
  after?: string;
  /** Page size, 1–100. */
  limit?: number;
}

/** Versioned deterministic semantic implemented by Hue's environment kernel. */
export type SemanticEntry =
  | "hue.collection.get@1"
  | "hue.collection.list@1"
  | "hue.collection.search@1"
  | "hue.collection.create@1"
  | "hue.collection.update@1"
  | "hue.gmail.search_messages@1"
  | "hue.gmail.get_message@1"
  | "hue.gmail.get_thread@1"
  | "hue.gmail.create_draft@1"
  | "hue.gmail.update_draft@1"
  | "hue.slack.search@1"
  | "hue.slack.read_channel@1"
  | "hue.slack.read_thread@1"
  | "hue.slack.draft@1"
  | "hue.slack.destination@1";
/** One parameter in an authored environment action. */
export interface EnvironmentActionParameter {
  /** Agent-visible parameter name. */
  name: string;
  /** Supported flat parameter type. */
  type: "string" | "number" | "boolean" | "string[]";
  /** Whether the argument is required; defaults to `true`. */
  required?: boolean;
  /** Agent-visible parameter description. */
  description?: string;
  /** Allowed string values, when constrained. */
  enum?: string[];
}
/** Configuration interpreted by a versioned environment semantic. */
export interface EnvironmentSemanticConfig {
  /** Primary state collection. */
  collection: string;
  /** Draft collection used by provider-shaped mail semantics. */
  draftsCollection?: string;
  /** Synthetic Slack actor identity. */
  slackActorId?: string;
  /** Synthetic Slack workspace identity. */
  slackWorkspaceId?: string;
  /** Synthetic mailbox address. */
  mailboxAddress?: string;
  /** Parameter that supplies an entity identity. */
  idParam?: string;
  /** Parameter that supplies a search query. */
  queryParam?: string;
  /** Entity fields projected into observations. */
  fields?: string[];
  /** Field-to-parameter equality filter. */
  filter?: {
    /** Stored entity field. */
    field: string;
    /** Action parameter compared with the field. */
    param: string;
  };
  /** Maximum records returned by a read semantic. */
  limit?: number;
  /** Literal fields written by a mutation semantic. */
  set?: Record<string, JsonValue>;
  /** Parameter names copied into written fields. */
  setFromParams?: string[];
  /** Prefix for deterministically generated entity identities. */
  idPrefix?: string;
  /** Preconditions evaluated before a mutation. */
  guards?: Array<{
    /** Stored field to inspect. */
    field: string;
    /** Required field value. */
    equals: string | number | boolean | null;
    /** Stable observation error when the guard fails. */
    error: string;
  }>;
  /** Stable observation error for a missing entity. */
  notFoundError?: string;
}
/** Agent-visible action mapped to one deterministic kernel semantic. */
export interface EnvironmentActionDeclaration {
  /** Unique action name. */
  name: string;
  /** Agent-visible action description. */
  description?: string;
  /** Flat action parameters. */
  params?: EnvironmentActionParameter[];
  /** Versioned semantic and its configuration. */
  semantics: {
    /** Kernel semantic implementation. */
    entry: SemanticEntry;
    /** Semantic configuration. */
    config: EnvironmentSemanticConfig;
  };
  /** Observation projection; identity is the only V1 projection. */
  observation?: {
    /** Return the semantic's observation unchanged. */
    projection: "identity";
  };
}
/** Complete V1 authored-world document stored as an immutable version. */
export interface EnvironmentDefinition {
  /** Definition schema discriminator. */
  schemaVersion: 1;
  /** Optional human-readable world description. */
  description?: string;
  /** Deterministic virtual-clock configuration. */
  determinism?: {
    /** Virtual-clock settings. */
    clock?: {
      /** Initial virtual nanoseconds as a decimal string. */
      startNs?: string;
      /** Nanoseconds advanced after each recorded step. */
      stepAdvanceNs?: string;
    };
  };
  /** Initial normalized collection/entity state. */
  state: {
    /** Collections keyed by collection, entity and field names. */
    collections: Record<string, Record<string, Record<string, JsonValue>>>;
  };
  /** Closed catalog exposed by this world. */
  actions: EnvironmentActionDeclaration[];
  /** How this definition was produced. */
  provenance?:
    | {
        /** Authored directly by a developer. */
        kind: "handwritten";
      }
    | {
        /** Generated from synthetic source material. */
        kind: "synthetic";
        /** Optional generation note. */
        note?: string;
      }
    | {
        /** Derived from one immutable trace revision. */
        kind: "derived_from_trace";
        /** Source trace identity. */
        traceId: string;
        /** Source trace revision. */
        revision: number;
      };
  /** Caller-owned immutable metadata. */
  metadata?: Record<string, JsonValue>;
}
/** The extendable legacy name remains V1. Publication and runs select their
 * explicit version; provider context is validated by the authoritative server. */
export type EnvironmentDefinitionV1 = EnvironmentDefinition;
/** One synthetic Gmail principal and its world-state collection bindings. */
export interface GmailProviderInstance {
  /** Stable instance key referenced by attempt provider selection. */
  providerInstanceKey: string;
  /** Provider discriminator for the V2 Gmail slice. */
  providerId: "google.gmail";
  /** Synthetic principal UUID, canonicalized to lowercase by Hue. */
  syntheticPrincipalId: string;
  /** Versioned mapping from Gmail concepts to authored-world collections. */
  configuration: {
    /** Gmail mailbox configuration discriminator. */
    kind: "gmail_mailbox/v1";
    /** Collection containing synthetic messages. */
    messagesCollection: string;
    /** Collection containing synthetic drafts. */
    draftsCollection: string;
    /** Synthetic mailbox address. */
    mailboxAddress: string;
  };
}
/** V2 authored world with immutable provider-instance bindings. */
export interface EnvironmentDefinitionV2 extends Omit<EnvironmentDefinition, "schemaVersion"> {
  /** Definition schema discriminator. */
  schemaVersion: 2;
  /** Provider instances available to a strict attempt profile. */
  providerInstances: GmailProviderInstance[];
}
/** Definition accepted by immutable environment publication. */
export type PublishableEnvironmentDefinition = EnvironmentDefinitionV1 | EnvironmentDefinitionV2;
/** Full immutable environment version and its generated action catalog. */
export interface EnvironmentVersion extends EnvironmentVersionSummary {
  /** Owning environment identity. */
  environmentId: string;
  /** Stored, defaulted authored definition. */
  definition: PublishableEnvironmentDefinition;
  /** Generated agent-visible actions. */
  actions: ActionDefinition[];
}
/** JSON Schema subset generated for one action's input. */
export interface ActionSchema {
  /** Actions always accept an object. */
  type: "object";
  /** Parameter schemas keyed by parameter name. */
  properties: Record<
    string,
    | {
        /** Scalar JSON Schema type. */
        type: "string" | "number" | "boolean";
        /** Agent-visible parameter description. */
        description?: string;
        /** Allowed string values, when constrained. */
        enum?: string[];
      }
    | {
        /** Array JSON Schema type. */
        type: "array";
        /** Bounded string item schema. */
        items: {
          /** Array items are strings. */
          type: "string";
          /** Maximum item length. */
          maxLength: number;
        };
        /** Maximum array length. */
        maxItems: number;
        /** Agent-visible parameter description. */
        description?: string;
      }
  >;
  /** Required parameter names. */
  required: string[];
  /** Unknown action arguments are rejected. */
  additionalProperties: false;
}
/** One generated framework-neutral action. */
export interface ActionDefinition {
  /** Unique action name. */
  name: string;
  /** Agent-visible description. */
  description?: string;
  /** Generated input contract. */
  inputSchema: ActionSchema;
  /**
   * MCP `initialize` identity when this action is served by one MCP surface.
   * Bound environment tools record it on the tool span as `mcp.server.name`.
   */
  mcp?: McpServerInfo;
}
/** Recorded answer returned by the simulated world. */
export interface Observation {
  /** Whether the world accepted or refused the action. */
  status: "ok" | "error";
  /** Additional bounded observation fields. */
  [key: string]: JsonValue;
}
/** One normalized world-state effect caused by an action. */
export interface Effect {
  /** Mutation category. */
  kind: "created" | "updated" | "deleted";
  /** Affected collection. */
  collection: string;
  /** Affected entity identity. */
  entityId: string;
  /** Changed field names. */
  fields: string[];
}
/** Newly created isolated world and its action catalog. */
export interface EnvironmentRun {
  /** Environment-run identity. */
  id: string;
  /** Immutable environment version used by the run. */
  environmentVersionId: string;
  /** Current virtual nanoseconds as a decimal string. */
  clockNs: string;
  /** Digest of current world state. */
  stateDigest: string;
  /** Maximum recorded actions. */
  maxSteps: number;
  /** Lease expiry timestamp. */
  expiresAt: string;
  /** Closed generated action catalog. */
  actions: ActionDefinition[];
}
/** Result of invoking one environment action. */
export interface ActionResult {
  /** Environment-run identity. */
  runId: string;
  /** Zero-based journal ordinal. */
  stepOrdinal: number;
  /** World observation returned to the agent. */
  observation: Observation;
  /** Normalized state effects. */
  effects: Effect[];
  /** Digest after the action. */
  stateDigest: string;
  /** Virtual nanoseconds after the action. */
  clockNs: string;
  /** Whether Hue replayed a previously recorded invocation. */
  replayed: boolean;
  /** Remaining step budget. */
  stepsRemaining: number;
}
/** Durable first-fault report for known missing provider behavior. */
export interface CoverageGapInput {
  /** Stable idempotency key for retrying a lost acknowledgement. */
  idempotencyKey: string;
  /** Provider boundary that received the valid request. */
  provider: string;
  /** Provider operation that is not modeled. */
  operation: string;
  /** Stable coverage-gap code. */
  code: string;
  /** First-fault arguments are bounded to 16,000 JSON bytes. */
  args: Record<string, JsonValue>;
  /** Nonsecret explanation of the unsupported behavior. */
  description: string;
}
/** Stored coverage gap with reporting provenance. */
export interface CoverageGap extends Omit<CoverageGapInput, "idempotencyKey"> {
  /** Server timestamp of the first report. */
  reportedAt: string;
  /** Authenticated actor that reported the gap. */
  reportedBy: {
    /** Actor credential class. */
    kind: "project_key" | "user";
    /** Actor identity. */
    id: string;
  };
}
/** Missing fields from older servers mean not_assessed, never verified parity. */
export interface EnvironmentCoverage {
  /** Whether a known simulator gap invalidates agent evaluation. */
  validity?: "not_assessed" | "environment_incomplete";
  /** First durable gap, or `null` when no gap was reported. */
  coverageGap?: CoverageGap | null;
}
/** Confirmation that a coverage gap was durably recorded. */
export interface CoverageGapResult {
  /** Affected environment-run identity. */
  runId: string;
  /** Incomplete is the only successful reporting result. */
  validity: "environment_incomplete";
  /** Preserved first coverage gap. */
  coverageGap: CoverageGap;
}
/** Authoritative current or sealed state of an environment run. */
export interface RunState extends EnvironmentCoverage {
  /** Environment-run identity. */
  id: string;
  /** Immutable environment version used by the run. */
  environmentVersionId: string;
  /** Linked target execution, or `null` for a standalone run. */
  executionId: string | null;
  /** Deterministic run seed. */
  seed: string;
  /** Run lifecycle state. */
  status: "open" | "completed" | "abandoned" | "expired";
  /** Number of recorded steps. */
  stepCount: number;
  /** Maximum recorded actions. */
  maxSteps: number;
  /** Current virtual nanoseconds as a decimal string. */
  clockNs: string;
  /** Lease expiry timestamp. */
  expiresAt: string;
  /** Creation timestamp. */
  createdAt: string;
  /** Seal timestamp, or `null` while open. */
  sealedAt: string | null;
  /** Digest of current or final state. */
  stateDigest: string;
  /** Final state, available after sealing. */
  finalState?: JsonValue;
}
/** One immutable journal entry. */
export interface Step {
  /** Step identity. */
  id: string;
  /** Zero-based journal ordinal. */
  ordinal: number;
  /** Caller invocation identity used for replay protection. */
  invocationId: string;
  /** Invoked action name. */
  action: string;
  /** Validated action arguments. */
  args: Record<string, JsonValue>;
  /** World observation returned to the agent. */
  observation: Observation;
  /** Normalized state effects. */
  effects: Effect[];
  /** Whether state changed. */
  mutated: boolean;
  /** Virtual nanoseconds after the action. */
  clockNs: string;
  /** State digest after the action. */
  stateDigest: string;
}
/** One ordinal page of environment journal steps. */
export interface StepPage {
  /** Steps on this page. */
  items: Step[];
  /** Next step ordinal, or `null` at the end. */
  nextCursor: number | null;
}
/** Confirmation that an environment run was sealed. */
export interface SealedRun {
  /** Environment-run identity. */
  id: string;
  /** Requested terminal state. */
  status: "completed" | "abandoned";
  /** Final number of journal steps. */
  stepCount: number;
  /** Final state digest. */
  stateDigest: string;
  /** Seal timestamp. */
  sealedAt: string;
}
/** Options for creating one fresh isolated world. */
export interface CreateRunInput {
  /** Stable idempotency key for recovering creation acknowledgement. */
  idempotencyKey: string;
  /** Immutable environment version to instantiate. */
  environmentVersionId: string;
  /** Target execution linked to this world. */
  executionId?: string;
  /** Optional deterministic seed. */
  seed?: string;
  /** Optional action ceiling, 1–500. */
  maxSteps?: number;
  /** Optional lease in seconds. */
  ttlSeconds?: number;
}
/** Request to invoke one action. */
export interface ActionInput {
  /** Stable logical invocation identity. */
  invocationId: string;
  /** Action name from the run's catalog. */
  action: string;
  /** Action arguments; omitted means an empty object. */
  args?: Record<string, JsonValue>;
}
/** Request to seal an environment run. */
export interface FinishRunInput {
  /** Stable idempotency key for recovering seal acknowledgement. */
  idempotencyKey: string;
  /** Completed for accepted outcomes; abandoned for failures/cancellation. */
  status: "completed" | "abandoned";
}
/** Ordinal pagination for an environment journal. */
export interface StepPageOptions {
  /** Last seen ordinal; `-1` starts at the first step. */
  after?: number;
  /** Page size, 1–100. */
  limit?: number;
}
