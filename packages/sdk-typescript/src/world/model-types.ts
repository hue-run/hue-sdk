import type { WorldModelProcessing, WorldPreparationProgress } from "./readiness.js";
export type { WorldModelProcessing, WorldPreparationProgress } from "./readiness.js";

/** Project-scoped identity of the user or entity represented by a World model. */
export interface WorldEntity {
  /** Identifier namespace, such as the application's user namespace. */
  namespace: string;
  /** Full external identifier. */
  id: string;
}
/** Continuously enriched history belonging to one entity in one project. */
export interface WorldModel {
  /** Stable identity of this record. */
  id: string;
  /** Project owning this World model. */
  projectId: string;
  /** Full external identity represented by the model. */
  entity: WorldEntity;
  /** Display name. */
  name: string;
  /** Creation timestamp in RFC 3339 format. */
  createdAt: string;
  /** Last successful instance start, or null when never used. */
  lastUsedAt: string | null;
  /** Committed evidence sequence used for reconstruction. */
  evidenceCutoff: number;
  /** Publication or erasure state. */
  status: "ready" | "preparing" | "erased";
  /** Retained and indexed progress, when reported by Hue. */
  processing?: WorldModelProcessing;
}
/** One app account bound to a World model. */
export interface WorldModelAccount {
  /** Stable identity of this record. */
  id: string;
  /** App simulation identifier. */
  providerId: string;
  /** Account-specific binding key used by the simulation gateway. */
  providerInstanceKey: string;
  /** External account identity. */
  accountId: string;
  /** Connection generation that separates account rebinding. */
  generation: number;
  /** Optional tenant or workspace scope within the external account. */
  scope?: string;
  /** Stable simulation principal for this account binding. */
  syntheticPrincipalId: string;
}
/** Immutable reconstructed starting state at a represented time and evidence cutoff. */
export interface StartingWorld {
  /** Stable identity of this record. */
  id: string;
  /** World model from which this state was reconstructed. */
  modelId: string;
  /** Represented time as an ISO 8601 timestamp with a timezone. */
  at: string;
  /** Committed evidence sequence used for reconstruction. */
  evidenceCutoff: number;
  /** Immutable starting-state digest, or null while preparation is incomplete. */
  digest: string | null;
  /** Publication or erasure state. */
  status: "ready" | "preparing";
}
/** Bounded pagination over World models or their accounts. */
export interface WorldModelPageOptions {
  /** Opaque cursor returned by the previous page. */
  after?: string;
  /** Maximum entries in the page, from 1 to 100. */
  limit?: number;
}
/** One page of World models. */
export interface WorldModelPage {
  /** Entries in this page. */
  items: WorldModel[];
  /** Cursor for the next page, omitted when no further entries remain. */
  nextCursor?: string;
}
/** One page of account bindings. */
export interface WorldModelAccountPage {
  /** Entries in this page. */
  items: WorldModelAccount[];
  /** Cursor for the next page, omitted when no further entries remain. */
  nextCursor?: string;
}
/** Creates or retrieves the World model for an entity. */
export interface CreateWorldModelInput {
  /** Full external identity represented by the model. */
  entity: WorldEntity;
  /** Display name. */
  name?: string;
}
/** Starts an isolated instance using the latest completed reconstruction of a chosen time. */
export interface StartWorldInstanceInput {
  /** Caller-owned identity reused for retries of this exact operation. */
  idempotencyKey: string;
  /** Represented time as an ISO 8601 timestamp with a timezone. */
  at: string;
  /** Requested instance lifetime in seconds. */
  ttlSeconds?: number;
}

/** Reproduces an earlier starting World under a durable request identity. */
export interface ReproduceWorldInstanceInput {
  /** Caller-owned identity reused for retries of this exact operation. */
  idempotencyKey: string;
  /** Requested instance lifetime in seconds. */
  ttlSeconds?: number;
}

/** One World model returned by create or get. */
export interface WorldModelResult {
  /** Entity history and its current committed evidence sequence. */
  worldModel: WorldModel;
}
/** One reconstructed starting World without a running instance. */
export interface StartingWorldResult {
  /** Immutable starting state, or an explicit preparing state. */
  world: StartingWorld;
  /** Progress of this requested starting World, when reported by Hue. */
  preparation?: WorldPreparationProgress;
}
/** Acknowledgement that the World model has been erased. */
export interface ErasedWorldModel {
  /** Successful erasure acknowledgement. */
  erased: true;
}
