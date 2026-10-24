import type { Answer, JsonObject } from "./world-http.js";

/**
 * What `hue world create --export-from <app>` shares across apps: the error that ends an export,
 * the exchange a call is recorded as, and the JSON files the exported objects are uploaded in.
 * Each app's reader lives in `world-export-<app>.ts`.
 */

/** Hue's limit for one uploaded file. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** A failure that ends the export; its message names no credential. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

/** Request headers that carry a credential: never recorded. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key"]);

/** One recorded call: the request as sent, with its headers but without its credential, and the
 * answer as given, with its headers (Slack names a token's scopes only in `x-oauth-scopes`).
 * Cookies are left out. */
export function exchange(
  request: { url: string; headers: Record<string, string> },
  answer: Answer,
): JsonObject {
  const sent = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())),
  );
  const headers: Record<string, string> = {};
  answer.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  return {
    request: { method: "GET", url: request.url, headers: sent, body: null },
    response: { status: answer.status, headers, body: answer.body },
  };
}

/** Whether an object fits one file of its own. */
export const fitsOneFile = (object: unknown, maxBytes = MAX_FILE_BYTES): boolean =>
  Buffer.byteLength(JSON.stringify(object)) + 2 <= maxBytes;

/**
 * The objects as JSON files, each one array within Hue's per-file limit, in their order.
 * shortcut: an export is held in memory until it is packed, which suits the size Hue accepts in
 * one World; write the files as the export goes once Hue accepts exports larger than memory.
 */
export function packJson(objects: readonly unknown[], maxBytes = MAX_FILE_BYTES): Buffer[] {
  const files: Buffer[] = [];
  let parts: string[] = [];
  let size = 0;
  for (const object of objects) {
    const text = JSON.stringify(object);
    // Each object counts its comma or the opening bracket; the closing bracket is the `+ 1`.
    const bytes = Buffer.byteLength(text) + 1;
    if (bytes + 1 > maxBytes) throw new ExportError("An exported object is larger than one file");
    if (size + bytes + 1 > maxBytes) {
      files.push(Buffer.from(`[${parts.join(",")}]`));
      parts = [];
      size = 0;
    }
    parts.push(text);
    size += bytes;
  }
  if (parts.length) files.push(Buffer.from(`[${parts.join(",")}]`));
  return files;
}
