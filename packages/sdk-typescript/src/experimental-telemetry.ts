import type { HueClient } from "./client.js";
import type { ExperimentalTelemetrySettings } from "./types.js";

/**
 * Per-call telemetry for AI SDK 6: pass as `experimental_telemetry`. Spans are created with Hue's
 * tracer, so they parent under `withSpan` and inherit session/user identifiers, and prompt/response
 * recording follows `captureContent`. AI SDK 7 applications use `hueTelemetry` from `@hue-run/sdk/ai-sdk`.
 */
export function hueExperimentalTelemetry(hue: HueClient): ExperimentalTelemetrySettings {
  return {
    isEnabled: hue.enabled,
    recordInputs: hue.captureContent,
    recordOutputs: hue.captureContent,
    tracer: hue.tracer,
  };
}
