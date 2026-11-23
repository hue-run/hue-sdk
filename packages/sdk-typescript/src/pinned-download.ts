import dns from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { pipeline, Readable, type Transform } from "node:stream";
import * as zlib from "node:zlib";

/**
 * Downloads from a link a remote service chose (a Langfuse media link, a Hue media grant): the
 * addresses such a link may not reach, the lookup that resolves its host once, and the GET that
 * connects to the checked address instead of resolving the host again.
 */

/** Addresses a download link may not reach: this machine, private networks, link-local
 * (cloud metadata), shared, benchmarking, multicast and reserved ranges. IPv4-mapped IPv6
 * addresses are checked as their IPv4 address. */
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

/** Whether an IP address is one {@link INTERNAL_ADDRESSES} holds; false for anything else. An
 * IPv6 zone index is left out, since Bun's BlockList does not match an address that has one. */
export function isInternalAddress(address: string): boolean {
  const version = isIP(address);
  const bare = address.replace(/%.*$/u, "");
  return version !== 0 && INTERNAL_ADDRESSES.check(bare, version === 4 ? "ipv4" : "ipv6");
}

/** The decoders that undo the answer's content codings, applied last first; null when a coding
 * cannot be undone here (one this runtime has no decoder for), so the body must pass through as
 * it came, as fetch passes an unknown coding through. */
function contentDecoders(header: string | undefined): Transform[] | null {
  const decoders: Transform[] = [];
  const encodings = (header ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding && encoding !== "identity");
  for (const encoding of encodings.reverse()) {
    if (encoding === "gzip" || encoding === "x-gzip") decoders.push(zlib.createGunzip());
    else if (encoding === "deflate") decoders.push(zlib.createInflate());
    else if (encoding === "br") decoders.push(zlib.createBrotliDecompress());
    else if (encoding === "zstd" && typeof zlib.createZstdDecompress === "function")
      decoders.push(zlib.createZstdDecompress());
    else return null;
  }
  return decoders;
}

/**
 * One GET of `url` connected to `address` rather than a lookup of its own, so a download reaches
 * exactly the public address its caller verified and a second DNS answer cannot rebind it onto a
 * private network. TLS still validates the certificate against the URL's hostname
 * (`servername`), and the Host header carries it. Content codings are decoded as fetch decodes
 * them, so a store that serves pre-compressed objects still yields readable bytes and a size
 * bound reads decoded bytes. Redirects are answered, never followed; `tls` lets a test name its
 * own authority.
 */
export function pinnedDownload(
  url: URL,
  init: { headers: Record<string, string>; signal: AbortSignal },
  address: string,
  tls: { ca?: string | Buffer } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: address,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        headers: { ...init.headers, host: url.host },
        signal: init.signal,
        ...tls,
      },
      (answer) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(answer.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(", "));
        }
        let stream: Readable = answer;
        const decoders = contentDecoders(answer.headers["content-encoding"]) ?? [];
        if (decoders.length) {
          stream = decoders[decoders.length - 1]!;
          // Cancelling the body or a failed decoder must close every upstream stream too.
          pipeline([answer, ...decoders], () => undefined);
        }
        const status = answer.statusCode ?? 502;
        // node:stream/web's ReadableStream and the global one are the same object at runtime;
        // their declarations only differ. A null-body status must construct with a null body.
        const body =
          status === 204 || status === 205 || status === 304
            ? null
            : (Readable.toWeb(stream) as unknown as ReadableStream);
        resolve(new Response(body, { status, headers }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

/** Every address `host` resolves to, through the resolver fetch and node:https use; rejects once
 * `signal` aborts, since a lookup cannot be cancelled. */
export function resolvedAddresses(host: string, signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("The lookup was abandoned"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    dns.lookup(host, { all: true }, (error, entries) => {
      signal.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve(entries.map((entry) => entry.address));
    });
  });
}
