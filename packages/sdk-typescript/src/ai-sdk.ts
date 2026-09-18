import { createRequire } from "node:module";
import { OpenTelemetry } from "@ai-sdk/otel";
import type { TelemetryOptions } from "ai";
import type { HueClient } from "./client.js";

/** Use as the call's telemetry option; it does not change global AI SDK integrations. */
export function hueTelemetry(hue: HueClient): TelemetryOptions {
  // Core tracing also installs beside AI SDK 6. This adapter requires the v7
  // per-call integration API; fail explicitly during configuration on v6.
  if (hue.enabled) {
    const { version } = createRequire(import.meta.url)("ai/package.json") as { version: string };
    const [major, minor, patch] = version.split(".").map(Number);
    if (major !== 7 || (minor === 0 && patch < 99))
      throw new TypeError(
        "hueTelemetry requires ai@^7.0.99; AI SDK 6 applications pass hueExperimentalTelemetry(hue) from @hue-run/sdk as experimental_telemetry",
      );
  }
  return {
    isEnabled: hue.enabled,
    recordInputs: hue.captureContent,
    recordOutputs: hue.captureContent,
    integrations: [new OpenTelemetry({ tracer: hue.tracer, usage: true })],
  };
}
