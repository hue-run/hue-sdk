import type { HueOptions } from "./types.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CONTENT_BYTES = 256 * 1024;

export function validateOptions(
  options: HueOptions,
): Required<
  Pick<HueOptions, "apiKey" | "serviceName" | "baseUrl" | "captureContent" | "timeoutMillis">
> &
  HueOptions {
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
  return { ...options, baseUrl: url.origin, timeoutMillis };
}
