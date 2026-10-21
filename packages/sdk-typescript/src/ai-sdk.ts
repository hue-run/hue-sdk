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

/** Options for {@link hueTelemetry}. */
export interface HueTelemetryOptions {
  /**
   * The runtime-context key whose value names the end user, recorded as `user.id` on the call's
   * spans. `"userId"` by default; `false` records no user from runtime context.
   */
  userKey?: string | false;
  /**
   * The runtime-context keys whose value names the conversation, recorded as
   * `gen_ai.conversation.id` on the call's spans; the first key with a value wins.
   * `["sessionId", "threadId"]` by default; `false` records no conversation from runtime context.
   */
  sessionKey?: string | readonly string[] | false;
}

const runtimeKeys = (value: string | readonly string[] | false, option: string): string[] => {
  const keys = value === false ? [] : typeof value === "string" ? [value] : [...value];
  if (keys.some((key) => typeof key !== "string" || !key))
    throw new TypeError(`hueTelemetry ${option} must be a non-empty runtime-context key or false`);
  return keys;
};

/** A runtime-context value usable as an identifier: a string or finite number, 1–4096 valid
 * characters with no NUL, as `withSpan` accepts for `userId` and `sessionId`. */
function identifierFrom(value: unknown): string | undefined {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined;
  return text && text.length <= 4096 && !text.includes("\u0000") && text.isWellFormed()
    ? text
    : undefined;
}

/** The identifier under the first of `keys` that holds a usable one. */
function firstIdentifier(
  context: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = identifierFrom(context?.[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * Per-call telemetry for AI SDK 7: pass as an agent's or generation call's `telemetry` option.
 * Spans come from Hue's tracer, so they parent under `withSpan` and inherit session, user and
 * workspace identifiers; prompt and response recording follow `captureContent`. It does not
 * change global AI SDK integrations.
 *
 * The end user and conversation can also come from the call's AI SDK runtime context: the value
 * under `userKey` (`userId` by default) is recorded as `user.id`, and the first value under
 * `sessionKey` (`sessionId`, then `threadId`) as `gen_ai.conversation.id`, on every span of the
 * call. The returned `includeRuntimeContext` names those keys, which AI SDK otherwise withholds
 * from telemetry; no other runtime-context value is recorded. An enclosing `withSpan`'s
 * `userId` or `sessionId` takes precedence.
 *
 * @throws TypeError when the client is enabled and the installed `ai` major version is below 7;
 * AI SDK 6 applications use `hueExperimentalTelemetry` from `@hue-run/sdk` instead.
 * @throws TypeError when `userKey` or `sessionKey` names an empty key.
 */
export function hueTelemetry(hue: HueClient, options: HueTelemetryOptions = {}): TelemetryOptions {
  // Core tracing also installs beside AI SDK 6. This adapter needs the v7 per-call
  // integration API, so fail explicitly during configuration instead of silently on v6.
  if (hue.enabled) {
    const major = aiMajor();
    if (major !== undefined && major < 7)
      throw new TypeError(
        "hueTelemetry requires ai@7 or later; AI SDK 6 applications pass hueExperimentalTelemetry(hue) from @hue-run/sdk as experimental_telemetry",
      );
  }
  const userKeys = runtimeKeys(options.userKey ?? "userId", "userKey");
  const sessionKeys = runtimeKeys(options.sessionKey ?? ["sessionId", "threadId"], "sessionKey");
  const keys = [...new Set([...userKeys, ...sessionKeys])];
  return {
    isEnabled: hue.enabled,
    recordInputs: hue.captureContent,
    recordOutputs: hue.captureContent,
    ...(keys.length
      ? { includeRuntimeContext: Object.fromEntries(keys.map((key) => [key, true])) }
      : {}),
    integrations: [
      new OpenTelemetry({
        tracer: hue.tracer,
        usage: true,
        ...(keys.length
          ? {
              enrichSpan: ({ runtimeContext }) => {
                const user = firstIdentifier(runtimeContext, userKeys);
                const session = firstIdentifier(runtimeContext, sessionKeys);
                return {
                  ...(user ? { "user.id": user } : {}),
                  ...(session ? { "gen_ai.conversation.id": session } : {}),
                };
              },
            }
          : {}),
      }),
    ],
  };
}
