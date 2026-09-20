import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const MIB = 1024 * 1024;

/** @internal Single-attempt signed write; callers settle uncertain outcomes through verified completion. */
export async function uploadOnce(
  url: string,
  data: Uint8Array,
  headers: Record<string, string>,
  deadline: number,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("deadline");
  const signal = AbortSignal.timeout(remaining);
  await new Promise<void>((resolve, reject) => {
    let activeResponse: import("node:http").IncomingMessage | undefined;
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      activeResponse?.destroy();
      request.destroy();
      finish(new Error("Hue managed upload failed"));
    };
    // Signed writes must not be replayed by fetch, redirect handling or a
    // reused-socket retry. A lost response is settled by Hue's verified read.
    const request = (new URL(url).protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "PUT",
        agent: false,
        signal,
        maxHeaderSize: 16 * 1024,
        headers: { ...headers, "content-length": String(data.byteLength) },
      },
      (response) => {
        activeResponse = response;
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          finish(new Error("Hue managed upload failed"));
          return;
        }
        void (async () => {
          let length = 0;
          for await (const chunk of response) {
            signal.throwIfAborted();
            length += Buffer.byteLength(chunk);
            if (length > MIB) throw new Error("Upload response too large");
          }
          signal.throwIfAborted();
          finish();
        })().catch(() => {
          response.destroy();
          finish(new Error("Hue managed upload failed"));
        });
      },
    );
    request.once("error", () => finish(new Error("Hue managed upload failed")));
    signal.addEventListener("abort", abort, { once: true });
    request.end(Buffer.from(data));
  });
}

/** @internal Validate a capability without changing its signed bytes. */
export function safeUploadUrl(value: unknown, allowLoopbackHttp = false): string {
  // eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f]/u.test(value))
    throw new TypeError("Invalid upload URL");
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new TypeError("Invalid upload URL");
  // Validate without rewriting the provider's signed capability.
  return value;
}
/** @internal Only upload metadata is accepted; project/ambient credentials are never forwarded. */
export function uploadHeaders(value: unknown, contentType: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": contentType };
  if (value === undefined || value === null) return headers;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected object");
  for (const [name, raw] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (
      typeof raw !== "string" ||
      !raw ||
      raw.length > 255 ||
      // eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
      /[\x00-\x1f\x7f]/u.test(raw)
    )
      throw new TypeError("Invalid string");
    const value = raw;
    if (lower === "content-type" && value === contentType) headers[lower] = value;
    else if (lower === "x-vercel-blob-access" && value === "private") headers[lower] = value;
    else throw new TypeError("Unsupported upload header");
  }
  return headers;
}
