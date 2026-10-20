import type { Attributes } from "@opentelemetry/api";
import { isCredentialKey } from "./tool-definitions.js";
import type { ToolEndpoint } from "./types.js";

/** Copy evidence, never send a request or resolve an endpoint from a tool name. */
export function toolEndpointAttributes(endpoint: ToolEndpoint): Attributes {
  if (
    !endpoint ||
    typeof endpoint.url !== "string" ||
    endpoint.url.length > 8192 ||
    /[\s\\\p{Cc}]/u.test(endpoint.url) ||
    /%(?![0-9a-f]{2})/i.test(endpoint.url) ||
    !["request", "client_config", "receipt"].includes(endpoint.source)
  )
    throw new Error("Invalid tool endpoint evidence");
  const url = new URL(endpoint.url);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid tool endpoint protocol");
  const names = endpoint.captureQueryParameters ?? [];
  if (
    !Array.isArray(names) ||
    names.length > 32 ||
    names.some(
      (name) =>
        typeof name !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name) ||
        isCredentialKey(name),
    )
  )
    throw new Error("Invalid tool endpoint query allowlist");
  // Keep the raw pairs, including duplicates and empty values. Re-encoding or selecting the
  // first value can turn missing, malformed or ambiguous routing evidence into a usable ID.
  const query = url.search
    .slice(1)
    .split("&")
    .filter((pair) => {
      const key = decodeURIComponent(pair.split("=", 1)[0]!.replace(/\+/g, " "));
      return names.includes(key);
    })
    .join("&");
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = query;
  const attributes: Attributes = {
    "url.full": url.href,
    "hue.tool.endpoint.source": endpoint.source,
  };
  if (endpoint.method !== undefined) {
    if (
      typeof endpoint.method !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(endpoint.method)
    )
      throw new Error("Invalid tool endpoint method");
    attributes["http.request.method"] = endpoint.method;
  }
  return attributes;
}
