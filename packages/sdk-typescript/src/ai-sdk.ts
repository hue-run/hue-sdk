import { OpenTelemetry } from "@ai-sdk/otel";
import type { TelemetryOptions } from "ai";
import type { HueClient } from "./client.js";

/** Use as the call's telemetry option; it does not change global AI SDK integrations. */
export function hueTelemetry(hue: HueClient): TelemetryOptions {
  return {
    isEnabled: true,
    recordInputs: hue.captureContent,
    recordOutputs: hue.captureContent,
    integrations: [new OpenTelemetry({ tracer: hue.tracer, usage: true })],
  };
}
