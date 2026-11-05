import { endedEvent, worldSchema, type HookConfig } from "./contracts.ts";
import { Store } from "./store.ts";
import { runAdapter } from "./adapter.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

async function readBounded(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("world_response_empty");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1_048_576) {
        await reader.cancel();
        throw new Error("world_response_too_large");
      }
      parts.push(value);
    }
    return Buffer.concat(parts);
  } finally {
    reader.releaseLock();
  }
}

export class Worker {
  readonly config: HookConfig;
  readonly store: Store;
  readonly environment: NodeJS.ProcessEnv;
  private running: Promise<void> | null = null;
  private connection: Promise<Client> | null = null;
  constructor(config: HookConfig, store: Store, environment: NodeJS.ProcessEnv) {
    this.config = config;
    this.store = store;
    this.environment = environment;
  }
  private client() {
    this.connection ??= this.connect().catch((error) => {
      this.connection = null;
      throw error;
    });
    return this.connection;
  }
  private async connect() {
    const key = this.environment.HUE_HOOK_STATUS_KEY;
    if (!key || key.startsWith("hue_world_")) throw new Error("project_read_key_required");
    const origin = new URL(this.config.origin);
    const url = new URL(
      origin.hostname === "app.hue.run"
        ? "https://mcp.hue.run/mcp"
        : origin.hostname === "staging.hue.run"
          ? "https://mcp.staging.hue.run/mcp"
          : "/api/mcp",
      origin,
    );
    url.searchParams.set("project", this.config.projectId);
    url.searchParams.set("read_only", "true");
    url.searchParams.set("toolsets", "instances");
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(10_000),
          ]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("world_status_unavailable");
        }
        if (response.status === 202 || response.status === 204) return response;
        const bytes = await readBounded(response);
        return new Response(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    const client = new Client({ name: "hue-world-lifecycle-hooks", version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool({ name: "list_projects", arguments: {} }, undefined, {
        timeout: 10_000,
      });
      if (result.isError) throw new Error("world_scope_unavailable");
      const projects = z
        .object({ projects: z.array(z.object({ id: z.uuid() })) })
        .parse(result.structuredContent);
      if (projects.projects.length !== 1 || projects.projects[0]?.id !== this.config.projectId)
        throw new Error("world_scope_mismatch");
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  async world() {
    const connection = this.client();
    const client = await connection;
    try {
      return await this.readWorld(client);
    } catch (error) {
      // A server can expire its MCP session independently of this process.
      // The next poll must initialize again and revalidate the project pin.
      if (this.connection === connection) {
        this.connection = null;
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }
  private async readWorld(client: Client) {
    const result = await client.callTool(
      { name: "get_instance", arguments: { instance_id: this.config.worldId } },
      undefined,
      { timeout: 10_000 },
    );
    if (result.isError) throw new Error("world_status_unavailable");
    const { instance } = z
      .object({
        instance: z.object({
          instance_id: z.uuid(),
          lifecycle: z.string(),
          activity: z.string(),
          status: z.string(),
          sealed_at: z.string().nullable(),
        }),
      })
      .parse(result.structuredContent);
    const world = worldSchema.parse({
      worldId: instance.instance_id,
      projectId: this.config.projectId,
      lifecycle: instance.lifecycle,
      activity: instance.activity,
      status: instance.status,
      sealedAt: instance.sealed_at,
    });
    if (world.worldId !== this.config.worldId) throw new Error("world_scope_mismatch");
    return world;
  }
  tick() {
    this.running ??= this.work().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async initialize() {
    if (!this.store.terminal()) await this.world();
  }
  private async work() {
    let terminal = this.store.terminal();
    if (!terminal) {
      const world = await this.world();
      if (
        world.lifecycle !== "sealed" &&
        (world.lifecycle !== "live" || world.activity !== "active")
      )
        return;
      if (world.lifecycle === "sealed") {
        this.store.enqueue(endedEvent(this.config, world));
        terminal = this.store.terminal();
      }
    }
    if (terminal) {
      this.store.cancelLogins();
    }
    const claimed = this.store.claim(terminal ? "world.ended" : "auth.outcome");
    if (!claimed) return;
    const ok = await runAdapter(this.config, claimed.event, this.environment).catch(() => false);
    this.store.settle(claimed.event.idempotencyKey, claimed.lease, ok);
  }
  async settled() {
    await this.running?.catch(() => undefined);
  }
  async close() {
    await this.settled();
    await (await this.connection?.catch(() => null))?.close();
  }
}
