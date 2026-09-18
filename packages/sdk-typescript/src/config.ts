import type { HueOptions } from "./types.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CONTENT_BYTES = 256 * 1024;

/** Loopback hostnames that may use plain HTTP without opting in. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** True when a validated origin exports over plain HTTP to a host other than loopback. */
export function isInsecureOrigin(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === "http:" && !isLoopbackHost(url.hostname);
}

export function validateOptions(
  options: HueOptions,
): Required<
  Pick<
    HueOptions,
    "apiKey" | "serviceName" | "baseUrl" | "captureContent" | "timeoutMillis" | "maxQueueBytes"
  >
> &
  HueOptions {
  if (typeof options.captureContent !== "boolean")
    throw new TypeError("Choose captureContent explicitly: true or false");
  if (options.enabled !== undefined && typeof options.enabled !== "boolean")
    throw new TypeError("enabled must be a boolean");
  if (options.enabled === false)
    return {
      captureContent: options.captureContent,
      enabled: false,
      apiKey: "",
      serviceName: "hue-disabled",
      baseUrl: "https://app.hue.run",
      timeoutMillis: 10000,
      maxQueueBytes: 8 * 1024 * 1024,
    };
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
  if (options.allowInsecureHttp !== undefined && typeof options.allowInsecureHttp !== "boolean")
    throw new TypeError("allowInsecureHttp must be a boolean");
  if (
    options.resourceAttributes !== undefined &&
    (options.resourceAttributes === null ||
      typeof options.resourceAttributes !== "object" ||
      Array.isArray(options.resourceAttributes))
  )
    throw new TypeError("resourceAttributes must be an object of attribute values");
  let url: URL;
  try {
    url = new URL(options.baseUrl ?? "https://app.hue.run");
  } catch {
    throw new TypeError("Invalid Hue baseUrl");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new TypeError("Hue baseUrl must use https, or http for a loopback development server");
  if (
    url.protocol === "http:" &&
    !isLoopbackHost(url.hostname) &&
    options.allowInsecureHttp !== true
  )
    throw new TypeError(
      "Hue requires HTTPS except for a loopback development server; set allowInsecureHttp: true to export over plain HTTP to another host",
    );
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
