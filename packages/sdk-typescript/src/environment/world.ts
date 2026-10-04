import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentRun, LegacyMcpCapability, WorldHandoff, WorldMcpServer } from "./types.js";

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
    now: run.now ?? run.env.HUE_WORLD_NOW ?? null,
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

/**
 * The world's clock: what an agent reads for today's date in place of the wall clock, so a
 * date-relative request (tomorrow, `newer_than:7d`, this month) lands on the dates the world
 * holds however long after the recording the run starts. From the handoff's `now`, else from
 * `HUE_WORLD_NOW` in the given environment (this process's by default, where `hue eval
 * --command` and `agentEnvironment` set it). Null when neither names it.
 */
export function worldNow(
  source: WorldHandoff | Record<string, string | undefined> = process.env,
): Date | null {
  const text =
    "env" in source && typeof source.env === "object" && source.env !== null
      ? ((source as WorldHandoff).now ?? (source as WorldHandoff).env.HUE_WORLD_NOW)
      : (source as Record<string, string | undefined>).HUE_WORLD_NOW;
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Variables that authenticate against Hue's control plane rather than a simulated provider. */
export const HUE_CONTROL_PLANE_VARIABLES: readonly string[] = [
  "HUE_API_KEY",
  "HUE_MCP_KEY",
  "HUE_PROJECT_KEY",
  "HUE_SERVICE_KEY",
];
/** Prefixes of the Hue control-plane credentials the server issues: project and setup keys,
 * attempt grants, the project MCP key, invocation and installation tokens, and OAuth tokens and
 * secrets. World tokens (`hue_world_`) and MCP capabilities (`hue_sim_`) are what the agent holds. */
export const HUE_CONTROL_PLANE_CREDENTIAL_PREFIXES: readonly string[] = [
  "hue_sk_",
  "hue_attempt_",
  "hue_mcp_",
  "hue_setup_",
  "hue_inv_",
  "hue_install_",
  "hue_at_",
  "hue_rt_",
  "hue_oauth_",
];
/** A Hue credential anywhere in a value (`Bearer hue_sk_…`, a URL, a JSON blob), not inside a longer word. */
const HUE_CREDENTIAL_SHAPE = new RegExp(
  `(?:^|[^A-Za-z0-9_])(?:${HUE_CONTROL_PLANE_CREDENTIAL_PREFIXES.join("|")})`,
);
const ASCII_PERCENT_ESCAPE = /%[0-7][0-9a-f]/i;

function hasHueControlPlaneCredential(value: string): boolean {
  let decoded = value;
  for (let layer = 0; layer <= 4; layer++) {
    if (HUE_CREDENTIAL_SHAPE.test(decoded)) return true;
    if (!ASCII_PERCENT_ESCAPE.test(decoded)) return false;
    if (layer === 4) return true;
    decoded = decoded.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
  return false;
}

/** True for a control-plane variable by name, or for a value carrying a Hue control-plane
 * credential anywhere in it, including wrapped or percent-encoded values. */
export function isHueControlPlaneCredential(name: string, value: string | undefined): boolean {
  if (HUE_CONTROL_PLANE_VARIABLES.includes(name)) return true;
  return typeof value === "string" && hasHueControlPlaneCredential(value);
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

/** Options for {@link agentEnvironment}. */
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

/** Variables a world or its server owns: a parent's value belongs to another world (a runner
 * started inside a case, a shell left from an earlier run) or to the server (a signing key), and
 * would send this world's token to a mirror this world does not have. The whole `HUE_WORLD_`
 * prefix is the world's. */
const WORLD_SCOPED =
  /^(?:HUE_WORLD_[A-Z0-9_]+|HUE_MCP_(?:CONFIG|URL|TOKEN|EXPIRES_AT)|HUE_SIM_[A-Z0-9_]+_(?:URL|ALIAS))$/;

/** `environment` without any variable a world or its server owns. */
export function withoutWorldVariables(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !WORLD_SCOPED.test(name)),
  );
}

/**
 * The environment for an agent child process running one case (the coordination briefs'
 * recommended policy): the parent's variables minus Hue control-plane credentials and any
 * world-scoped variable, then the world's carriers. Nothing here is logged.
 */
export function agentEnvironment(
  world: WorldHandoff,
  options: AgentEnvironmentOptions = {},
): Record<string, string> {
  const parent = options.parent ?? process.env;
  const child = withoutWorldVariables(
    options.includeHueCredentials
      ? Object.fromEntries(
          Object.entries(parent).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        )
      : stripHueControlPlaneCredentials(parent),
  );
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
export function legacyMcpCapability(world: WorldHandoff): LegacyMcpCapability | undefined {
  const server: WorldMcpServer | undefined = Object.values(world.mcpConfig.mcpServers)[0];
  if (!server) return undefined;
  return { url: server.url, token: world.token, expiresAt: world.expiresAt };
}

/** The owner-only `mcpServers` file {@link writeMcpConfig} wrote. */
export interface McpConfigFile {
  /** The owner-only file; pass its path to the harness and dispose after the run. */
  path: string;
  /** Removes the file and its private directory; safe to call twice. */
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
