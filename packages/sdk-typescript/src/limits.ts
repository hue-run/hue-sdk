import type { IncomingHttpHeaders } from "node:http";
import { MAX_BODY_BYTES, MAX_CONTENT_BYTES, MAX_DECODED_BYTES } from "./config.js";

/**
 * What a Hue receiver accepts. Every OTLP acknowledgement, whatever its status, advertises these
 * (`Hue-Max-Request-Bytes`, `Hue-Max-Decoded-Bytes`, `Hue-Max-Value-Bytes`); until one arrives an
 * exporter assumes the receiver's limits as of this release.
 */
export interface ReceiverLimits {
  /** Bytes of one request on the wire, after gzip. */
  readonly requestBytes: number;
  /** Bytes of one request after decompression. */
  readonly decodedBytes: number;
  /** Bytes of one attribute value or log body the receiver keeps inline. */
  readonly valueBytes: number;
}

const KIB = 1024;
const MIB = 1024 * KIB;

/** The limits assumed before a receiver advertises its own. */
export const DEFAULT_RECEIVER_LIMITS: ReceiverLimits = Object.freeze({
  requestBytes: MAX_BODY_BYTES,
  decodedBytes: MAX_DECODED_BYTES,
  valueBytes: MAX_CONTENT_BYTES,
});

/**
 * The ordinary size of one request before gzip. Advertised limits are ceilings, not targets: a
 * receiver decodes a larger request more slowly, so batches stay at this size, or the advertised
 * decoded limit when that is lower, and only a single record that needs more is sent alone in a
 * larger request, up to the advertised ceilings.
 */
export const BATCH_TARGET_BYTES = 4 * MIB;

/** Each advertised limit's header and the range it is clamped to, so a faulty value cannot make
 * requests unboundedly large or too small to carry a record. */
const ADVERTISED: readonly {
  field: keyof ReceiverLimits;
  header: string;
  min: number;
  max: number;
}[] = [
  { field: "requestBytes", header: "hue-max-request-bytes", min: MIB, max: 64 * MIB },
  { field: "decodedBytes", header: "hue-max-decoded-bytes", min: MIB, max: 64 * MIB },
  { field: "valueBytes", header: "hue-max-value-bytes", min: 256 * KIB, max: 16 * MIB },
];

/** A decimal integer header value, else undefined. */
function decimal(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^[0-9]{1,20}$/.test(text)) return undefined;
  return Number(text);
}

/**
 * `current` with every limit a response advertised adopted, clamped to its range; `current`
 * itself when the response advertised none, or the same values. A lower advertised limit is
 * adopted as readily as a higher one: the exporter never exceeds what the receiver last said.
 */
export function advertisedLimits(
  current: ReceiverLimits,
  headers: IncomingHttpHeaders,
): ReceiverLimits {
  let next: ReceiverLimits = current;
  for (const { field, header, min, max } of ADVERTISED) {
    const value = decimal(headers[header]);
    if (value === undefined) continue;
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== next[field]) next = { ...next, [field]: clamped };
  }
  return next === current ? current : Object.freeze(next);
}

/** Whether `bytes` before gzip are certain to stay within `limit` after it: deflate's worst case
 * (stored blocks) adds a few bytes per 16 KiB, plus gzip's header and trailer. */
export function fitsWithoutCompression(bytes: number, limit: number): boolean {
  return bytes + Math.ceil(bytes / 1024) + 64 <= limit;
}
