#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ScenesClient } from "./scenes/api.js";
import { Playback } from "./scenes/playback.js";
import { servePlaybackMcp } from "./scenes-mcp.js";
async function main() {
  const { values } = parseArgs({
    options: {
      scene: { type: "string" },
      revision: { type: "string" },
      digest: { type: "string" },
      binding: { type: "string" },
    },
    allowPositionals: false,
  });
  if (!values.scene || !values.revision || !values.digest || !values.binding)
    throw new Error("A scene, revision, digest and binding are required");
  const revision = Number(values.revision);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !/^[a-f0-9]{64}$/.test(values.digest)
  )
    throw new Error("Invalid snapshot pin");
  const apiKey = process.env.HUE_API_KEY;
  if (!apiKey) throw new Error("HUE_API_KEY is required");
  const client = new ScenesClient({
    apiKey,
    baseUrl: process.env.HUE_BASE_URL,
    capture: false,
  });
  const playback = await Playback.load(
    client,
    { sceneId: values.scene, revision, digest: values.digest },
    [values.binding],
  );
  const handle = servePlaybackMcp(playback, values.binding);
  let stopping = false;
  const stop = async (state: "completed" | "interrupted") => {
    if (stopping) return;
    stopping = true;
    await handle.close();
    await playback.complete(state);
  };
  process.once("SIGINT", () => {
    void stop("interrupted").then(
      () => process.exit(130),
      () => process.exit(1),
    );
  });
  process.once("SIGTERM", () => {
    void stop("interrupted").then(
      () => process.exit(143),
      () => process.exit(1),
    );
  });
  process.stdin.once("end", () => {
    void stop("completed").catch(() => {
      process.stderr.write("Hue Scenes replay reporting failed\n");
      process.exitCode = 1;
    });
  });
}
main().catch(() => {
  process.stderr.write(
    "Hue Scenes MCP startup failed. Check the snapshot pin, namespace, and HUE_API_KEY/HUE_BASE_URL.\n",
  );
  process.exitCode = 1;
});
