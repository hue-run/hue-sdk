import type { BlockList, LookupFunction } from "node:net";
import { isLoopbackHost } from "./config.js";

/**
 * Where bytes sent to an upload URL Hue answered may go. Hue chooses the URL, so a hostile or
 * compromised Hue must not be able to aim it at this machine or its network. A Hue on this
 * machine (a development server) may name any HTTPS store, or a loopback HTTP one, connected as
 * named. Any other Hue may name only HTTPS (or HTTP with `allowInsecureHttp`) on a host whose
 * every address is public, and the upload must connect to exactly those addresses
 * ({@link pinnedTo}, {@link pinnedFetch}): a second lookup could answer another address.
 */
export interface UploadRoute {
  /** The checked addresses the connection must use; absent to connect as the URL names. */
  addresses?: readonly [string, ...string[]];
}

let ranges: { nonPublic: BlockList; globalV6: BlockList } | undefined;

/** Not globally reachable (the IANA special-purpose registries), so never an upload store's:
 * this machine, private and shared networks, link-local (cloud metadata), benchmarking,
 * documentation, multicast and reserved ranges. IPv6 is public only within global unicast
 * (2000::/3), which leaves out IPv4-mapped, NAT64, unique-local and link-local addresses. */
async function addressRanges() {
  if (ranges) return ranges;
  const { BlockList } = await import("node:net");
  const nonPublic = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ] as const)
    nonPublic.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
  ] as const)
    nonPublic.addSubnet(network, prefix, "ipv6");
  const globalV6 = new BlockList();
  globalV6.addSubnet("2000::", 3, "ipv6");
  ranges = { nonPublic, globalV6 };
  return ranges;
}

/** Whether `address`, an IP address, is globally reachable. */
async function isPublicAddress(address: string): Promise<boolean> {
  const { isIP } = await import("node:net");
  const { nonPublic, globalV6 } = await addressRanges();
  const version = isIP(address);
  if (version === 4) return !nonPublic.check(address, "ipv4");
  return version === 6 && globalV6.check(address, "ipv6") && !nonPublic.check(address, "ipv6");
}

/**
 * The route for an upload to `url`, a URL in an answer of the Hue at `hue` (its origin);
 * undefined when the bytes may not be sent there. Rejects when the URL's host cannot be resolved,
 * which callers treat as a network failure.
 */
export async function uploadRoute(
  url: URL,
  hue: string,
  allowInsecureHttp = false,
): Promise<UploadRoute | undefined> {
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (allowInsecureHttp || isLoopbackHost(url.hostname)))
  )
    return undefined;
  if (url.username || url.password) return undefined;
  if (isLoopbackHost(new URL(hue).hostname)) return {};
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const { isIP } = await import("node:net");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    const { lookup } = await import("node:dns/promises");
    addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
  }
  const [first, ...rest] = addresses;
  if (first === undefined) return undefined;
  for (const address of addresses) if (!(await isPublicAddress(address))) return undefined;
  return { addresses: [first, ...rest] };
}

/** `node:http` request options whose connection goes to the checked `addresses` instead of a
 * lookup of its own; the Host header and TLS verification still name the URL's host. */
export function pinnedTo(addresses: readonly [string, ...string[]]): { lookup: LookupFunction } {
  const entries = addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
  return {
    lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, entries);
      else callback(null, entries[0]!.address, entries[0]!.family);
    },
  };
}

/**
 * A fetch for uploads on a pinned {@link UploadRoute}: it connects only to `addresses`. A
 * redirect is answered, never followed. A body of bytes or text is sent with its length; a
 * stream with the `content-length` the caller set.
 */
export function pinnedFetch(
  addresses: readonly [string, ...string[]],
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = new URL(input);
    const { request } =
      url.protocol === "https:" ? await import("node:https") : await import("node:http");
    const { Readable } = await import("node:stream");
    const headers: Record<string, string> = Object.fromEntries(new Headers(init.headers));
    const body = init.body;
    if (typeof body === "string" || body instanceof Uint8Array)
      headers["content-length"] = String(Buffer.byteLength(body));
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        url,
        {
          method: init.method ?? "GET",
          headers,
          agent: false,
          ...(init.signal ? { signal: init.signal } : {}),
          ...pinnedTo(addresses),
        },
        (answer) => {
          const answered = new Headers();
          for (const [name, value] of Object.entries(answer.headers)) {
            if (typeof value === "string") answered.set(name, value);
            else if (Array.isArray(value)) answered.set(name, value.join(", "));
          }
          const status = answer.statusCode ?? 502;
          // node:stream/web's ReadableStream and the global one are the same object at runtime.
          resolve(
            new Response(
              status === 204 || status === 205 || status === 304
                ? null
                : (Readable.toWeb(answer) as unknown as ReadableStream),
              { status, headers: answered },
            ),
          );
        },
      );
      outgoing.once("error", reject);
      if (body instanceof ReadableStream)
        Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream)
          .once("error", (error) => outgoing.destroy(error))
          .pipe(outgoing);
      else if (typeof body === "string" || body instanceof Uint8Array) outgoing.end(body);
      else if (body === undefined || body === null) outgoing.end();
      else {
        outgoing.destroy();
        reject(new TypeError("Unsupported upload body"));
      }
    });
  };
}
