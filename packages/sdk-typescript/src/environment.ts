export {
  createEnvironmentClient,
  EnvironmentClient,
  HueEnvironmentError,
} from "./environment/client.js";
export type { EnvironmentClientOptions } from "./environment/client.js";
export { bindEnvironmentTools } from "./environment/tools.js";
export type { BindEnvironmentToolsOptions, EnvironmentTool } from "./environment/tools.js";
export type * from "./environment/types.js";
export {
  agentEnvironment,
  HUE_CONTROL_PLANE_VARIABLES,
  isHueControlPlaneCredential,
  legacyMcpCapability,
  stripHueControlPlaneCredentials,
  worldHandoff,
  writeMcpConfig,
} from "./environment/world.js";
export type { AgentEnvironmentOptions, McpConfigFile } from "./environment/world.js";
