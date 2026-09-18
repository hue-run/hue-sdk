import { randomUUID } from "node:crypto";
import type { Context } from "@opentelemetry/api";
import type { HueClient } from "../client.js";
import type { EnvironmentClient } from "./client.js";
import type { ActionSchema, EnvironmentRun, JsonValue, Observation } from "./types.js";

export interface EnvironmentTool {
  name: string;
  description?: string;
  inputSchema: ActionSchema;
  execute(args?: Record<string, JsonValue>): Promise<Observation>;
}
export interface BindEnvironmentToolsOptions {
  hue: HueClient;
  client: Pick<EnvironmentClient, "act">;
  run: EnvironmentRun;
  parentContext?: Context;
  invocationId?(action: string): string;
}

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
        });
      },
    };
  }
  return tools;
}
