import { randomUUID } from "node:crypto";
import type { Context } from "@opentelemetry/api";
import type { HueClient } from "../client.js";
import type { EnvironmentClient } from "./client.js";
import type { ActionSchema, EnvironmentRun, JsonValue, Observation } from "./types.js";

/** Framework-neutral callable generated from one environment action. */
export interface EnvironmentTool {
  /** Tool name. */
  name: string;
  /** Agent-visible description. */
  description?: string;
  /** JSON Schema input contract. */
  inputSchema: ActionSchema;
  /** Executes the action and resolves with the world's observation. */
  execute(args?: Record<string, JsonValue>): Promise<Observation>;
}
/** Dependencies and tracing context for {@link bindEnvironmentTools}. */
export interface BindEnvironmentToolsOptions {
  /** Hue client used to record each action as tool telemetry. */
  hue: HueClient;
  /** Environment client bound to the same Hue origin. */
  client: Pick<EnvironmentClient, "act">;
  /** Fresh environment run whose closed catalog becomes callables. */
  run: EnvironmentRun;
  /** Optional parent span context for generated tool spans. */
  parentContext?: Context;
  /** Optional durable invocation-ID factory for caller-owned resume state. */
  invocationId?(action: string): string;
}

/**
 * Binds a run's generated catalog to plain local callables without changing the agent
 * framework. Each call is recorded through {@link HueClient.tool}. Catalog entries that
 * include `mcp` stamp `mcp.server.name` / `mcp.server.version` and `hue.mcp.provider` /
 * `hue.mcp.surface` so a generic verb is attributed to that MCP server and Hue surface.
 */
export function bindEnvironmentTools(
  options: BindEnvironmentToolsOptions,
): Record<string, EnvironmentTool> {
  const tools: Record<string, EnvironmentTool> = {};
  for (const action of options.run.actions) {
    tools[action.name] = {
      name: action.name,
      ...(action.description === undefined ? {} : { description: action.description }),
      inputSchema: action.inputSchema,
      execute: async (args = {}) => {
        const invocationId = options.invocationId?.(action.name) ?? randomUUID();
        const execute = async () =>
          (
            await options.client.act(options.run.id, {
              invocationId,
              action: action.name,
              args,
            })
          ).observation;
        return options.hue.tool(action.name, args, execute, {
          parentContext: options.parentContext,
          ...(action.mcp === undefined ? {} : { mcp: action.mcp }),
        });
      },
    };
  }
  return tools;
}
