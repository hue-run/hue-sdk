import { scrubCredentialTextUnbounded } from "./tool-definitions.js";

const credentialLabels = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "xapikey",
  "clientsecret",
  "password",
  "secret",
  "authorization",
  "authtoken",
]);

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Recognize credentials once, while preserving the raw spelling of ordinary resource IDs. */
function scrubPath(path: string): string {
  const raw = path.split("/");
  const decoded = raw.map(decodedSegment);
  const parts = decoded.flatMap((segment, rawIndex) =>
    segment.split("/").map((value) => ({ value, rawIndex })),
  );
  const masked = new Set<number>();
  for (let index = 0; index < decoded.length; index++)
    if (scrubCredentialTextUnbounded(decoded[index]!) !== decoded[index]) masked.add(index);
  const telegram = new Set<number>();
  let pending = false;
  const last = parts.findLastIndex((part) => part.value !== "");
  for (let index = 0; index < parts.length; index++) {
    const { value, rawIndex } = parts[index]!;
    if (!value) continue;
    if (masked.has(rawIndex)) {
      pending = false;
      continue;
    }
    if (pending) {
      masked.add(rawIndex);
      pending = false;
      continue;
    }
    if (/^bot[0-9]+:[A-Za-z0-9_-]+$/.test(value)) {
      if (decoded[rawIndex]!.includes("/")) masked.add(rawIndex);
      else telegram.add(rawIndex);
    }
    if (
      index === last &&
      /^[A-Za-z0-9_-]+$/.test(value) &&
      parts[index - 3]?.value.toLowerCase() === "services" &&
      /^T[A-Za-z0-9]+$/.test(parts[index - 2]?.value ?? "") &&
      /^B[A-Za-z0-9]+$/.test(parts[index - 1]?.value ?? "")
    ) {
      masked.add(rawIndex);
      continue;
    }
    if (credentialLabels.has(value.toLowerCase().replace(/[-_]/g, ""))) pending = true;
  }
  return raw
    .map((segment, index) => {
      if (masked.has(index)) return "[redacted]";
      if (telegram.has(index)) return "bot[redacted]";
      return segment;
    })
    .join("/");
}

/** HTTP identity never carries URL credentials, including recognized capability paths. */
export function scrubHttpUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("HTTP identity requires an HTTP URL");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = scrubPath(url.pathname);
  return url;
}

/** HTTP names can retain a full URL after a provider clips all identifying attributes. */
export function scrubHttpSpanName(name: string): string {
  return name.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      return scrubHttpUrl(value).href;
    } catch {
      return "[redacted]";
    }
  });
}
