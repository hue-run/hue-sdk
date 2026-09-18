import type { HueOptions, SharedHueOptions } from "./types.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CONTENT_BYTES = 256 * 1024;

// The return type stays anonymous: HueTransport.options exposes it through ReturnType, and the
// API reference must not reference a name that is not part of the public entry points.
export function validateOptions(options: HueOptions): HueOptions &
  Required<
    Pick<SharedHueOptions, "captureContent" | "baseUrl" | "timeoutMillis" | "maxQueueBytes">
  > & {
    apiKey: string;
    serviceName: string;
  } {
  if (options.enabled !== undefined && typeof options.enabled !== "boolean")
    throw new TypeError("enabled must be a boolean");
  if (options.enabled === false) {
    // The kill switch exports nothing, so the content decision defaults to metadata-only. The
    // diagnostics hook stays attached so a disabled client can still report why it is off.
    if (options.captureContent !== undefined && typeof options.captureContent !== "boolean")
      throw new TypeError("captureContent must be a boolean");
    return {
      ...(typeof options.onExportIssue === "function"
        ? { onExportIssue: options.onExportIssue }
        : {}),
      captureContent: options.captureContent ?? false,
      enabled: false,
      apiKey: "",
      serviceName: "hue-disabled",
      baseUrl: "https://app.hue.run",
      timeoutMillis: 10000,
      maxQueueBytes: 8 * 1024 * 1024,
    };
  }
  if (typeof options.captureContent !== "boolean")
    throw new TypeError("Choose captureContent explicitly: true or false");
  if (
    typeof options.apiKey !== "string" ||
    !options.apiKey ||
    options.apiKey.length > 4096 ||
    /\s/.test(options.apiKey) ||
    options.apiKey.includes("\u0000")
  )
    throw new TypeError("A valid Hue project API key is required");
  if (
    typeof options.serviceName !== "string" ||
    !options.serviceName.trim() ||
    options.serviceName.length > 256
  )
    throw new TypeError("A serviceName of 1–256 characters is required");
  let url: URL;
  try {
    url = new URL(options.baseUrl ?? "https://app.hue.run");
  } catch {
    throw new TypeError("Invalid Hue baseUrl");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new TypeError("Hue requires HTTPS except for a loopback development server");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new TypeError(
      "Hue baseUrl must be an origin without credentials, a path, query parameters or fragments",
    );
  const timeoutMillis = options.timeoutMillis ?? 10000;
  if (!Number.isInteger(timeoutMillis) || timeoutMillis < 100 || timeoutMillis > 60000)
    throw new TypeError("timeoutMillis must be 100–60000");
  const maxQueueBytes = options.maxQueueBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxQueueBytes) ||
    maxQueueBytes < 1024 ||
    maxQueueBytes > 64 * 1024 * 1024
  )
    throw new TypeError("maxQueueBytes must be 1024–67108864");
  return { ...options, baseUrl: url.origin, timeoutMillis, maxQueueBytes };
}
