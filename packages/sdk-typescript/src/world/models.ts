import { uuid } from "../evals/json.js";
import { WorldClient, type WorldClientOptions } from "./client.js";
import type {
  CreateWorldModelInput,
  WorldModelResult,
  StartingWorldResult,
  ErasedWorldModel,
  ReproduceWorldInstanceInput,
  StartingWorld,
  StartWorldInstanceInput,
  WorldModelAccountPage,
  WorldModelPage,
  WorldModelPageOptions,
} from "./model-types.js";
import type { WorldHandoff } from "./types.js";

/** Reconstructed starting World and its isolated runtime connection. */
export interface WorldInstanceResult {
  /** Immutable starting state used by the new instance. */
  world: StartingWorld;
  /** Fresh, instance-scoped connection and credentials. */
  instance: WorldHandoff;
}

/** Project-key client for entity histories, reconstructed Worlds and isolated instances. */
export class WorldModelClient extends WorldClient {
  /** Creates the client without starting a World or instance. */
  constructor(options: WorldClientOptions) {
    super(options);
  }

  /** Creates or retrieves the model for one full project-scoped entity identity. */
  createModel(input: CreateWorldModelInput) {
    return this.request<WorldModelResult>("POST", "/world-models", input);
  }

  /** Lists World models without loading their evidence or runtime state. */
  listModels(options: WorldModelPageOptions = {}) {
    return this.request<WorldModelPage>("GET", `/world-models${this.modelPage(options)}`);
  }

  /** Reads a model's identity and committed evidence cutoff. */
  getModel(modelId: string) {
    return this.request<WorldModelResult>("GET", `/world-models/${uuid(modelId)}`);
  }

  /** Lists account bindings, including multiple accounts of the same app. */
  listAccounts(modelId: string, options: WorldModelPageOptions = {}) {
    return this.request<WorldModelAccountPage>(
      "GET",
      `/world-models/${uuid(modelId)}/accounts${this.modelPage(options)}`,
    );
  }

  /** Reconstructs the chosen time with the latest committed evidence, without starting an instance. */
  materialize(modelId: string, input: { at: string }) {
    return this.request<StartingWorldResult>(
      "POST",
      `/world-models/${uuid(modelId)}/materializations`,
      input,
    );
  }

  /** Starts one isolated instance, replaying the same request identity after transport failures. */
  startInstance(modelId: string, input: StartWorldInstanceInput) {
    return this.request<WorldInstanceResult>(
      "POST",
      `/world-models/${uuid(modelId)}/instances`,
      input,
    );
  }

  /** Starts a fresh instance from the original immutable starting World of an earlier instance. */
  reproduceInstance(instanceId: string, input: ReproduceWorldInstanceInput) {
    return this.request<WorldInstanceResult>(
      "POST",
      `/instances/${uuid(instanceId)}/reproduce`,
      input,
    );
  }

  /** Revokes and erases a World model. Erased starting Worlds cannot be reproduced. */
  eraseModel(modelId: string) {
    return this.request<ErasedWorldModel>("DELETE", `/world-models/${uuid(modelId)}`);
  }

  private modelPage(options: WorldModelPageOptions) {
    const query = new URLSearchParams();
    if (options.after !== undefined) {
      if (typeof options.after !== "string" || !options.after)
        throw new TypeError("Page cursor must be a nonempty string");
      query.set("after", options.after);
    }
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
        throw new RangeError("Page limit must be 1–100");
      query.set("limit", String(options.limit));
    }
    return query.size ? `?${query}` : "";
  }
}
