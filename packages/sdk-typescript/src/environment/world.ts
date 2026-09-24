import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentRun, WorldHandoff, WorldMcpServer } from "./types.js";

/**
 * The world an agent acts on through provider mirrors, read from a create or replay response.
 * Null for a world created while the gateway was off: that world has Hue-native tools and no
 * mirror URLs. The handoff carries the world token; keep it out of logs and checkpoints.
 */
export function worldHandoff(run: EnvironmentRun): WorldHandoff | null {
  if (!run.token || !run.env || !run.mcpConfig || !run.surfaces) return null;
  const id = run.worldId ?? run.id;
  return {
    id,
    token: run.token,
    expiresAt: run.expiresAt,
    lifecycle: run.lifecycle ?? "live",
    completingUntil: run.completingUntil ?? null,
    traceparent: run.traceparent ?? null,
    baggage: run.baggage ?? `hue-world=${id}`,
    surfaces: run.surfaces.map((surface) => ({ ...surface })),
    env: { ...run.env },
    mcpConfig: {
      mcpServers: Object.fromEntries(
        Object.entries(run.mcpConfig.mcpServers).map(([name, server]) => [
          name,
          { type: server.type, url: server.url, headers: { ...server.headers } },
        ]),
      ),
    },
  };
}

/** Variables that authenticate against Hue's control plane rather than a simulated provider. */
export const HUE_CONTROL_PLANE_VARIABLES: readonly string[] = [
  "HUE_API_KEY",
  "HUE_MCP_KEY",
  "HUE_PROJECT_KEY",
  "HUE_SERVICE_KEY",
];
/** Hue's own credential shapes: project keys, attempt grants and the project MCP key. */
const HUE_CREDENTIAL_SHAPE = /^hue_(sk|attempt|mcp)_/;

/** True for a control-plane variable by name, or for any variable holding a Hue credential. */
export function isHueControlPlaneCredential(name: string, value: string | undefined): boolean {
  if (HUE_CONTROL_PLANE_VARIABLES.includes(name)) return true;
  return typeof value === "string" && HUE_CREDENTIAL_SHAPE.test(value.trim());
}

/** The parent's variables without Hue control-plane credentials; `undefined` values are dropped. */
export function stripHueControlPlaneCredentials(
  parent: Record<string, string | undefined>,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || isHueControlPlaneCredential(name, value)) continue;
    child[name] = value;
  }
  return child;
}

export interface AgentEnvironmentOptions {
  /** The environment to start from; defaults to this process's. */
  parent?: Record<string, string | undefined>;
  /** Keep Hue control-plane credentials in the child. Off by default: the agent gets world
   * tokens only (plan section 10.3) and the project key stays with the runner. */
  includeHueCredentials?: boolean;
  /** Also set `HUE_MCP_URL`, `HUE_MCP_TOKEN` and `HUE_MCP_EXPIRES_AT` from the world's first
   * MCP mirror, the names the `hue_sim_` bridge used, for one compatibility release. On by
   * default; the canonical carriers are the world's own `env`. */
  legacyMcpVariables?: boolean;
}

/**
 * The environment for an agent child process running one case (the coordination briefs'
 * recommended policy): the parent's variables minus Hue control-plane credentials, then the
 * world's carriers, which win over anything the parent set. Nothing here is logged.
 */
export function agentEnvironment(
  world: WorldHandoff,
  options: AgentEnvironmentOptions = {},
): Record<string, string> {
  const parent = options.parent ?? process.env;
  const child: Record<string, string> = options.includeHueCredentials
    ? Object.fromEntries(
        Object.entries(parent).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
    : stripHueControlPlaneCredentials(parent);
  Object.assign(child, world.env);
  if (options.legacyMcpVariables ?? true) {
    const legacy = legacyMcpCapability(world);
    if (legacy) {
      child.HUE_MCP_URL = legacy.url;
      child.HUE_MCP_TOKEN = legacy.token;
      child.HUE_MCP_EXPIRES_AT = legacy.expiresAt;
    }
  }
  return child;
}

/** The `{ url, token, expiresAt }` shape the `hue_sim_` capability had, projected from the
 * world's first MCP mirror so an adapter written for the bridge keeps working through the
 * compatibility release. Undefined for a world without an MCP surface. */
export function legacyMcpCapability(
  world: WorldHandoff,
): { url: string; token: string; expiresAt: string } | undefined {
  const server: WorldMcpServer | undefined = Object.values(world.mcpConfig.mcpServers)[0];
  if (!server) return undefined;
  return { url: server.url, token: world.token, expiresAt: world.expiresAt };
}

export interface McpConfigFile {
  /** The owner-only file; pass its path to the harness and dispose after the run. */
  path: string;
  dispose(): Promise<void>;
}

/**
 * Writes the world's `mcpConfig` as an owner-only file in a private directory (plan section
 * 4.9): the file carries the world token, so it is created with mode 0600 inside a 0700
 * directory, is never logged, and `dispose` removes the directory after the run.
 */
export async function writeMcpConfig(
  world: WorldHandoff,
  options: { directory?: string } = {},
): Promise<McpConfigFile> {
  const directory = await mkdtemp(join(options.directory ?? tmpdir(), "hue-world-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "mcp.json");
    await writeFile(path, `${JSON.stringify(world.mcpConfig, null, 2)}\n`, { mode: 0o600 });
    return { path, dispose };
  } catch (error) {
    // A half-written file would hold the token; never leave it behind.
    await dispose();
    throw error;
  }
}
