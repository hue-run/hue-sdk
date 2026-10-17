import type {
  EnvironmentDefinitionV1,
  EnvironmentVersion,
  JsonValue,
  PublishableEnvironmentDefinition,
} from "./types.js";

/** One account binding for any app registered by the Hue deployment. */
export interface WorldProviderInstance {
  /** Account-specific key used to select this binding. */
  providerInstanceKey: string;
  /** Registered app identifier. The server validates support. */
  providerId: string;
  /** Stable synthetic principal for this account connection. */
  syntheticPrincipalId: string;
  /** App-owned JSON configuration, validated by that app's simulation package. */
  configuration: Record<string, JsonValue>;
  /** Optional registered protocol dialects pinned for this binding. */
  dialects?: string[];
}

/** V1 authored starting-state definition. */
export type WorldDefinitionV1 = EnvironmentDefinitionV1;
/** Compatible V1 starting-state definition. */
export type WorldDefinition = WorldDefinitionV1;

/** Recorded app credential refusal, optionally restricted to one account binding. */
export interface WorldCredentialFailure {
  /** App identity. */
  provider: string;
  /** Protocol surface on which the refusal was observed. */
  surface: string;
  /** Recorded operation. */
  operation: string;
  /** Account binding affected by the refusal. */
  instance?: string;
  /** Optional recorded wire result. */
  result?: Record<string, JsonValue>;
}

/** Authored World with arbitrary registered apps and independently identified accounts. */
export interface WorldDefinitionV2 extends Omit<WorldDefinitionV1, "schemaVersion"> {
  /** Definition schema discriminator. */
  schemaVersion: 2;
  /** App/account bindings. Several entries may use the same provider. */
  providerInstances: WorldProviderInstance[];
  /** Recorded credential refusals, independently scoped to app accounts. */
  credentialFailures?: WorldCredentialFailure[];
}

/** Definitions accepted by canonical World publication, including legacy typed carriers. */
export type PublishableWorldDefinition =
  | WorldDefinitionV1
  | WorldDefinitionV2
  | PublishableEnvironmentDefinition;

/** Immutable published World version with an app-agnostic starting-state definition. */
export interface WorldVersion extends Omit<EnvironmentVersion, "definition"> {
  /** App/account-aware immutable starting-state definition. */
  definition: PublishableWorldDefinition;
}
