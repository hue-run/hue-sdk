export { ScenesClient } from "./scenes/api.js";
export { CaptureSession } from "./scenes/capture.js";
export { Playback, loadPlayback } from "./scenes/playback.js";
export { wrapTool } from "./scenes/context.js";
export {
  canonical,
  requestKey,
  SnapshotMissError,
  RecordedToolError,
  ScenesApiError,
} from "./scenes/portable.js";
export type * from "./scenes/types.js";
export { wrapAiTools, wrapMcpClient } from "./scenes/adapters.js";
export { wrapFetch } from "./scenes/http.js";
export type { ToolOptions } from "./scenes/context.js";
