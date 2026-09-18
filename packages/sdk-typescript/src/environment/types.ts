import type { JsonValue } from "../types.js";

export type { JsonValue } from "../types.js";

export interface EnvironmentIdentity {
  name: string;
  slug: string;
  description?: string;
}
export interface EnvironmentSummary extends Required<EnvironmentIdentity> {
  id: string;
  archivedAt: string | null;
}
export interface EnvironmentVersionSummary {
  id: string;
  version: number;
  contentDigest: string;
  createdAt: string;
}
export interface Environment extends EnvironmentSummary {
  versions: EnvironmentVersionSummary[];
}
export interface EnvironmentPage {
  items: EnvironmentSummary[];
  nextCursor: string | null;
}
export interface EnvironmentPageOptions {
  after?: string;
  limit?: number;
}

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
export interface EnvironmentActionParameter {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  required?: boolean;
  description?: string;
  enum?: string[];
}
export interface EnvironmentSemanticConfig {
  collection: string;
  draftsCollection?: string;
  slackActorId?: string;
  slackWorkspaceId?: string;
  mailboxAddress?: string;
  idParam?: string;
  queryParam?: string;
  fields?: string[];
  filter?: { field: string; param: string };
  limit?: number;
  set?: Record<string, JsonValue>;
  setFromParams?: string[];
  idPrefix?: string;
  guards?: Array<{ field: string; equals: string | number | boolean | null; error: string }>;
  notFoundError?: string;
}
export interface EnvironmentActionDeclaration {
  name: string;
  description?: string;
  params?: EnvironmentActionParameter[];
  semantics: { entry: SemanticEntry; config: EnvironmentSemanticConfig };
  observation?: { projection: "identity" };
}
export interface EnvironmentDefinition {
  schemaVersion: 1;
  description?: string;
  determinism?: { clock?: { startNs?: string; stepAdvanceNs?: string } };
  state: { collections: Record<string, Record<string, Record<string, JsonValue>>> };
  actions: EnvironmentActionDeclaration[];
  provenance?:
    | { kind: "handwritten" }
    | { kind: "synthetic"; note?: string }
    | { kind: "derived_from_trace"; traceId: string; revision: number };
  metadata?: Record<string, JsonValue>;
}
export interface EnvironmentVersion extends EnvironmentVersionSummary {
  environmentId: string;
  definition: EnvironmentDefinition;
  actions: ActionDefinition[];
}
export interface ActionSchema {
  type: "object";
  properties: Record<
    string,
    | { type: "string" | "number" | "boolean"; description?: string; enum?: string[] }
    | {
        type: "array";
        items: { type: "string"; maxLength: number };
        maxItems: number;
        description?: string;
      }
  >;
  required: string[];
  additionalProperties: false;
}
export interface ActionDefinition {
  name: string;
  description?: string;
  inputSchema: ActionSchema;
}
export interface Observation {
  status: "ok" | "error";
  [key: string]: JsonValue;
}
export interface Effect {
  kind: "created" | "updated" | "deleted";
  collection: string;
  entityId: string;
  fields: string[];
}
export interface EnvironmentRun {
  id: string;
  environmentVersionId: string;
  clockNs: string;
  stateDigest: string;
  maxSteps: number;
  expiresAt: string;
  actions: ActionDefinition[];
}
export interface ActionResult {
  runId: string;
  stepOrdinal: number;
  observation: Observation;
  effects: Effect[];
  stateDigest: string;
  clockNs: string;
  replayed: boolean;
  stepsRemaining: number;
}
export interface CoverageGapInput {
  idempotencyKey: string;
  provider: string;
  operation: string;
  code: string;
  /** First-fault arguments are bounded to 16,000 JSON bytes. */
  args: Record<string, JsonValue>;
  description: string;
}
export interface CoverageGap extends Omit<CoverageGapInput, "idempotencyKey"> {
  reportedAt: string;
  reportedBy: { kind: "project_key" | "user"; id: string };
}
/** Missing fields from older servers mean not_assessed, never verified parity. */
export interface EnvironmentCoverage {
  validity?: "not_assessed" | "environment_incomplete";
  coverageGap?: CoverageGap | null;
}
export interface CoverageGapResult {
  runId: string;
  validity: "environment_incomplete";
  coverageGap: CoverageGap;
}
export interface RunState extends EnvironmentCoverage {
  id: string;
  environmentVersionId: string;
  executionId: string | null;
  seed: string;
  status: "open" | "completed" | "abandoned" | "expired";
  stepCount: number;
  maxSteps: number;
  clockNs: string;
  expiresAt: string;
  createdAt: string;
  sealedAt: string | null;
  stateDigest: string;
  finalState?: JsonValue;
}
export interface Step {
  id: string;
  ordinal: number;
  invocationId: string;
  action: string;
  args: Record<string, JsonValue>;
  observation: Observation;
  effects: Effect[];
  mutated: boolean;
  clockNs: string;
  stateDigest: string;
}
export interface StepPage {
  items: Step[];
  nextCursor: number | null;
}
export interface SealedRun {
  id: string;
  status: "completed" | "abandoned";
  stepCount: number;
  stateDigest: string;
  sealedAt: string;
}
export interface CreateRunInput {
  idempotencyKey: string;
  environmentVersionId: string;
  executionId?: string;
  seed?: string;
  maxSteps?: number;
  ttlSeconds?: number;
}
export interface ActionInput {
  invocationId: string;
  action: string;
  args?: Record<string, JsonValue>;
}
export interface FinishRunInput {
  idempotencyKey: string;
  status: "completed" | "abandoned";
}
export interface StepPageOptions {
  after?: number;
  limit?: number;
}
