import { sceneContext, wrapTool, type ToolOptions } from "./context.js";
/** Wrap only explicitly registered source tools. Model calls and transforms remain untouched. */
export function wrapAiTools<T extends Record<string, unknown>>(
  bindingId: string,
  tools: T,
  options: Pick<ToolOptions, "contractVersion"> = {},
): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (
        !tool ||
        typeof tool !== "object" ||
        !("execute" in tool) ||
        typeof tool.execute !== "function"
      )
        return [name, tool];
      return [
        name,
        {
          ...tool,
          execute: wrapTool(
            bindingId,
            name,
            tool.execute as (...args: unknown[]) => unknown,
            (input) => input,
            options,
          ),
        },
      ];
    }),
  ) as T;
}
const mcpMethods: Record<
  string,
  (args: unknown[]) => { operation: string; arguments: unknown }
> = {
  callTool: ([params]) => {
    if (
      !params ||
      typeof params !== "object" ||
      !("name" in params) ||
      typeof params.name !== "string"
    )
      throw new TypeError("Invalid MCP tool request");
    return {
      operation: `tools/call:${params.name}`,
      arguments: "arguments" in params ? (params.arguments ?? {}) : {},
    };
  },
  readResource: ([params]) => ({
    operation: "resources/read",
    arguments: params ?? {},
  }),
  listTools: ([params]) => ({
    operation: "tools/list",
    arguments: params ?? {},
  }),
  listResources: ([params]) => ({
    operation: "resources/list",
    arguments: params ?? {},
  }),
  listResourceTemplates: ([params]) => ({
    operation: "resources/templates/list",
    arguments: params ?? {},
  }),
};
/** Structural adapter for MCP clients. Connection, cancellation and non-source methods stay live. */
export function wrapMcpClient<T extends object>(
  bindingId: string,
  client: T,
  options: Pick<ToolOptions, "contractVersion"> = {},
): T {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const describe = typeof key === "string" ? mcpMethods[key] : undefined;
      if (!describe) return value.bind(target);
      return (...args: unknown[]) => {
        const active = sceneContext.getStore();
        if (!active || active.suppressed || !active.runtime.selected(bindingId))
          return value.apply(target, args);
        let operation = String(key);
        let requestArguments: unknown;
        try {
          const call = describe(args);
          operation = call.operation;
          requestArguments = call.arguments;
        } catch {
          // Preserve the client's live validation/error while making failed extraction ineligible.
          requestArguments = Symbol("unsupported MCP arguments");
        }
        return wrapTool(
          bindingId,
          operation,
          () => value.apply(target, args),
          () => requestArguments,
          { ...options, resultMode: "promise" },
        )();
      };
    },
  });
}
