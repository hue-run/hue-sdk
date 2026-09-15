import {
  Server,
  ProtocolError,
  type CallToolResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ReadResourceResult,
  type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Playback } from "./scenes/playback.js";
import {
  canonical,
  json,
  RecordedToolError,
  SnapshotMissError,
} from "./scenes/portable.js";
import { isAsyncIterable } from "./scenes/context.js";
/** One frozen namespace per server; HTTP-only namespaces have no original MCP tool surface. */
export function createPlaybackMcpServer(
  playback: Playback,
  bindingId: string,
): Server {
  const binding = playback.bindings.find((b) => b.id === bindingId);
  if (!binding || binding.kind === "http" || !playback.selected(bindingId))
    throw new SnapshotMissError("incompatible");
  const operations =
    binding.operations?.filter((o) => o.kind !== "resource") ?? [];
  if (!operations.length) throw new SnapshotMissError("incompatible");
  const server = new Server(
    { name: `hue-scene-${bindingId}`, version: "1" },
    {
      capabilities: {
        tools: {},
        ...(binding.kind === "mcp" ? { resources: {} } : {}),
      },
    },
  );
  server.setRequestHandler("tools/list", () => ({
    tools: operations.map((o) => ({
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
      inputSchema: o.inputSchema as { type: "object" },
    })),
  }));
  const invoke = (operation: string, args: unknown) =>
    playback.invoke<unknown>(bindingId, operation, args, () => {
      throw new SnapshotMissError("unrecorded");
    });
  server.setRequestHandler("tools/call", async (request) => {
    try {
      if (!operations.some((o) => o.name === request.params.name))
        playback.reject(
          bindingId,
          request.params.name,
          request.params.arguments ?? {},
          "unrecorded",
        );
      const result = invoke(
        binding.kind === "mcp"
          ? `tools/call:${request.params.name}`
          : request.params.name,
        request.params.arguments ?? {},
      );
      if (isAsyncIterable(result))
        throw new SnapshotMissError(
          "nonportable",
          bindingId,
          request.params.name,
        );
      if (binding.kind === "mcp") {
        const value = json(result);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          !("content" in value) ||
          !Array.isArray(value.content) ||
          ("resultType" in value && value.resultType !== "accepted")
        )
          throw new SnapshotMissError(
            "nonportable",
            bindingId,
            request.params.name,
          );
        return value as unknown as CallToolResult;
      }
      if (result instanceof Uint8Array)
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `hue-scene://${encodeURIComponent(bindingId)}/${encodeURIComponent(request.params.name)}`,
                mimeType: "application/octet-stream",
                blob: Buffer.from(result).toString("base64"),
              },
            },
          ],
        };
      return {
        content: [
          {
            type: "text",
            text: result === undefined ? "undefined" : canonical(result),
          },
        ],
      };
    } catch (e) {
      if (e instanceof SnapshotMissError)
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: canonical({
                code: e.code,
                reason: e.reason,
                bindingId,
                operation: request.params.name,
              }),
            },
          ],
        };
      if (e instanceof RecordedToolError)
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: canonical({
                code: "HUE_RECORDED_TOOL_ERROR",
                type: e.recordedType,
              }),
            },
          ],
        };
      throw e;
    }
  });
  const resourceInvoke = (operation: string, args: unknown) => {
    try {
      return invoke(operation, args);
    } catch (e) {
      if (e instanceof SnapshotMissError)
        throw new ProtocolError(-32004, "HUE_SNAPSHOT_MISS", {
          code: e.code,
          reason: e.reason,
          bindingId,
          operation,
        });
      throw e;
    }
  };
  if (binding.kind === "mcp") {
    server.setRequestHandler(
      "resources/list",
      (r) =>
        resourceInvoke("resources/list", r.params ?? {}) as ListResourcesResult,
    );
    server.setRequestHandler(
      "resources/templates/list",
      (r) =>
        resourceInvoke(
          "resources/templates/list",
          r.params ?? {},
        ) as ListResourceTemplatesResult,
    );
    server.setRequestHandler(
      "resources/read",
      (r) => resourceInvoke("resources/read", r.params) as ReadResourceResult,
    );
  }
  return server;
}
export function servePlaybackMcp(
  playback: Playback,
  bindingId: string,
  transport?: Transport,
) {
  createPlaybackMcpServer(playback, bindingId);
  return serveStdio(() => createPlaybackMcpServer(playback, bindingId), {
    ...(transport ? { transport } : {}),
    onerror: () => playback.client.issue("mcp_transport"),
  });
}
