import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import { isLoopbackHost } from "./config.js";

/** Addresses a link a remote service chose may not reach: this machine, private networks,
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

/**
 * How a request that sends bytes to an upload URL Hue issued must connect. A Hue origin on this
 * machine, or one reached over plain HTTP (loopback, or the explicit `allowInsecureHttp` opt-in
 * for a network the application controls), may name what its caller's own checks admit:
 * `undefined`, the URL resolves as usual. Any other Hue must name HTTPS on a host whose every
 * address is public, so a hostile or compromised Hue cannot have this machine send the bytes to
 * itself or its private network. An address literal is checked here (`undefined`); a name must
 * connect through the returned lookup, which hands the connection exactly the addresses it
 * checked, so a second DNS answer cannot rebind it.
 *
 * @throws TypeError when the destination is refused.
 */
export function uploadLookup(url: URL, origin: string): LookupFunction | undefined {
  const hue = new URL(origin);
  if (hue.protocol === "http:" || isLoopbackHost(hue.hostname)) return undefined;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "https:" || isInternalAddress(host))
    throw new TypeError("The upload URL must use HTTPS to a public address");
  return isIP(host) ? undefined : publicLookup;
}

const publicLookup = ((
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, options.all ? [] : "", 0);
    if (addresses.length === 0 || addresses.some((entry) => isInternalAddress(entry.address))) {
      const refused: NodeJS.ErrnoException = new Error(
        `${hostname} resolves to an address on this machine or a private network`,
      );
      refused.code = "EINTERNALADDRESS";
      return callback(refused, options.all ? [] : "", 0);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}) as unknown as LookupFunction;

/**
 * A fetch that connects through `lookup`, for the upload {@link uploadLookup} pinned: fetch takes
 * no lookup, so this sends over node:http(s). It never follows a redirect or reuses a socket.
 * A body is a string, bytes, or a stream whose `content-length` the caller declares.
 */
export function pinnedFetch(
  lookup: LookupFunction,
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const { request } =
      new URL(url).protocol === "https:" ? await import("node:https") : await import("node:http");
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name] = value));
    const body = init.body ?? undefined;
    if (typeof body === "string" || body instanceof Uint8Array)
      headers["content-length"] ??= String(Buffer.byteLength(body));
    else if (body !== undefined && !(body instanceof ReadableStream))
      throw new TypeError("Unsupported upload body");
    return new Promise<Response>((resolve, reject) => {
      const sent = request(
        url,
        {
          method: init.method ?? "GET",
          headers,
          agent: false,
          lookup,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (answer) => {
          const status = answer.statusCode ?? 0;
          const answered = new Headers();
          for (const [name, value] of Object.entries(answer.headers))
            if (value !== undefined)
              answered.set(name, Array.isArray(value) ? value.join(", ") : value);
          try {
            const empty = status === 204 || status === 205 || status === 304;
            if (empty) answer.resume();
            resolve(
              new Response(empty ? null : (Readable.toWeb(answer) as unknown as ReadableStream), {
                status,
                headers: answered,
              }),
            );
          } catch (error) {
            answer.destroy();
            reject(error as Error);
          }
        },
      );
      sent.on("error", reject);
      if (body instanceof ReadableStream)
        pipeline(Readable.fromWeb(body as never), sent, (error) => error && reject(error));
      else sent.end(body);
    });
  };
}
