import { createRequire } from "node:module";
import { OpenTelemetry } from "@ai-sdk/otel";
import type { TelemetryOptions } from "ai";
import type { HueClient } from "./client.js";

let installedAiMajor: number | undefined;

/**
 * The installed `ai` major version, read once per process. An unreadable or unparsable version
 * is left to the peer dependency range rather than rejected here.
 */
function aiMajor(): number | undefined {
  if (installedAiMajor === undefined) {
    let major = Number.NaN;
    try {
      const manifest = createRequire(import.meta.url)("ai/package.json") as { version?: unknown };
      major = Number(String(manifest.version).split(".")[0]);
    } catch {
      /* The peer range decides. */
    }
    installedAiMajor = Number.isInteger(major) ? major : Number.NaN;
  }
  return Number.isNaN(installedAiMajor) ? undefined : installedAiMajor;
}

/**
 * Per-call telemetry for AI SDK 7: pass as an agent's or generation call's `telemetry` option.
 * Spans come from Hue's tracer, so they parent under `withSpan` and inherit session, user and
 * workspace identifiers; prompt and response recording follow `captureContent`. It does not
 * change global AI SDK integrations.
 *
 * @throws TypeError when the client is enabled and the installed `ai` major version is below 7;
 * AI SDK 6 applications use `hueExperimentalTelemetry` from `@hue-run/sdk` instead.
 */
export function hueTelemetry(hue: HueClient): TelemetryOptions {
  // Core tracing also installs beside AI SDK 6. This adapter needs the v7 per-call
  // integration API, so fail explicitly during configuration instead of silently on v6.
  if (hue.enabled) {
    const major = aiMajor();
    if (major !== undefined && major < 7)
      throw new TypeError(
        "hueTelemetry requires ai@7 or later; AI SDK 6 applications pass hueExperimentalTelemetry(hue) from @hue-run/sdk as experimental_telemetry",
      );
  }
  return {
    isEnabled: hue.enabled,
    recordInputs: hue.captureContent,
    recordOutputs: hue.captureContent,
    integrations: [new OpenTelemetry({ tracer: hue.tracer, usage: true })],
  };
}
