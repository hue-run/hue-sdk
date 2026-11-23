import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import { isLoopbackHost } from "./config.js";

/** Addresses a connection Hue or a provider chose may not reach: this machine, private networks,
 * link-local (cloud metadata), shared, benchmarking, multicast and reserved ranges. IPv4-mapped
 * IPv6 addresses are checked as their IPv4 address. */
const INTERNAL_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  INTERNAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  INTERNAL_ADDRESSES.addSubnet(network, prefix, "ipv6");

/** Whether an IP address is one {@link INTERNAL_ADDRESSES} holds; false for anything else. */
export function isInternalAddress(address: string): boolean {
  const version = isIP(address);
  return version !== 0 && INTERNAL_ADDRESSES.check(address, version === 4 ? "ipv4" : "ipv6");
}

/** Every address `host` resolves to; rejects once `signal` aborts, since a lookup cannot be
 * cancelled. */
export function resolved(host: string, signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("The lookup was abandoned"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    lookup(host, { all: true }).then(
      (entries) => resolve(entries.map((entry) => entry.address)),
      reject,
    );
  });
}

/**
 * How a PUT of file bytes to `url`, an upload URL Hue answered, connects; undefined when it is
 * refused. Hue chooses the URL, so unless `origin` is on this machine (a development server, which
 * may answer any URL its caller accepts) the URL must use HTTPS on `origin`'s own host, and every
 * address that host resolves to must be public. `anyHost` lifts the host and scheme rules for a
 * presigned store on another host, whose scheme the caller checks. A name is resolved once here:
 * `lookup` connects the request to the first of those checked addresses, so a second DNS answer
 * cannot move the bytes onto this machine's network.
 */
export async function uploadConnection(
  url: URL,
  origin: string,
  signal: AbortSignal,
  anyHost = false,
): Promise<{ lookup?: LookupFunction } | undefined> {
  const originHost = new URL(origin).hostname;
  if (isLoopbackHost(originHost)) return {};
  if (!anyHost && (url.protocol !== "https:" || url.hostname !== originHost)) return undefined;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolved(host, signal);
  } catch {
    return undefined;
  }
  const [address] = addresses;
  if (address === undefined || addresses.some(isInternalAddress)) return undefined;
  // An IP literal is where the connection goes already; only a name needs the pin.
  if (isIP(host)) return {};
  const family = isIP(address);
  return {
    lookup: (_hostname, options, callback) =>
      options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
  };
}

/**
 * One request sent as fetch sends it, but over node:http(s) connected through `lookup` when it is
 * given, TLS still validated against the URL's own host. A redirect is answered, never followed.
 */
export async function connectedFetch(
  url: string,
  init: RequestInit,
  lookup?: LookupFunction,
): Promise<Response> {
  const target = new URL(url);
  // Loaded on first use, as the other uploads load it, after an http instrumentation could patch it.
  const { request } =
    target.protocol === "https:" ? await import("node:https") : await import("node:http");
  const headers = Object.fromEntries(new Headers(init.headers));
  const body = init.body ?? undefined;
  if (body !== undefined && !(body instanceof Uint8Array) && !(body instanceof ReadableStream))
    throw new TypeError("Unsupported request body");
  if (body instanceof Uint8Array) headers["content-length"] ??= String(body.byteLength);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      target,
      {
        method: init.method ?? "GET",
        headers,
        agent: false,
        ...(init.signal ? { signal: init.signal } : {}),
        ...(lookup ? { lookup } : {}),
      },
      (answer) => {
        const status = answer.statusCode ?? 0;
        const answered = new Headers();
        for (const [name, value] of Object.entries(answer.headers))
          if (value !== undefined)
            answered.set(name, Array.isArray(value) ? value.join(", ") : value);
        try {
          resolve(
            new Response(
              status === 204 || status === 205 || status === 304
                ? null
                : (Readable.toWeb(answer) as unknown as ReadableStream),
              { status, headers: answered },
            ),
          );
        } catch (error) {
          answer.destroy();
          reject(error as Error);
        }
      },
    );
    outgoing.once("error", reject);
    if (body instanceof ReadableStream)
      pipeline(Readable.fromWeb(body as never), outgoing, () => undefined);
    else outgoing.end(body);
  });
}
