import { createHash } from "node:crypto";
import type { JsonValue } from "../types.js";

export type JsonBounds = { bytes: number; nodes: number; depth: number };
export const valueBounds: JsonBounds = { bytes: 200_000, nodes: 20_000, depth: 32 };
export function aggregateBounds(bytes: number): JsonBounds {
  return { bytes, nodes: Math.ceil(bytes / 2), depth: valueBounds.depth + 8 };
}
const isText = (item: string) => item.isWellFormed() && !item.includes("\u0000");

/** A string's code points: its UTF-16 length less one for each surrogate pair. */
function codePoints(text: string): number {
  let count = text.length;
  for (let index = 0; index < text.length - 1; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdbff) continue;
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) {
      count--;
      index++;
    }
  }
  return count;
}

/** Thrown within `json` when the byte bound is passed, which is checked last. */
class PastByteBound extends Error {}

/** Reject lossy JSON serialization before creating requests/checkpoints. */
export function json(value: unknown, requested: JsonBounds | number = valueBounds): JsonValue {
  const bounds = typeof requested === "number" ? { ...valueBounds, bytes: requested } : requested;
  const ancestors = new Set<object>();
  let nodes = 0;
  // The UTF-8 length of the JSON text, counted as the value is read, so a value too long to
  // serialize (past the runtime's longest string) is refused before `JSON.stringify` is asked to.
  let bytes = 0;
  // Once the byte bound is passed, the value is read again only to check it (below).
  let checking = false;
  // Text the second read has found valid is not checked again, so a string referenced many times
  // is scanned once: by content up to 16,383 UTF-16 units, and a longer string when it is the last
  // checked of its length. V8 hashes those by length alone, so a set of them would compare each
  // with every other of that length.
  const checkedText = new Set<string>();
  const checkedLong = new Map<number, string>();
  const text = (item: string) => {
    if (!checking) return isText(item);
    if (item.length <= 16_383 ? checkedText.has(item) : checkedLong.get(item.length) === item)
      return true;
    if (!isText(item)) return false;
    if (item.length <= 16_383) checkedText.add(item);
    else checkedLong.set(item.length, item);
    return true;
  };
  const charge = (amount: number) => {
    if (checking) return;
    bytes += amount;
    if (bytes > bounds.bytes) throw new PastByteBound();
  };
  // A string's JSON text is at least as long as the string, so one longer than what is left is
  // refused before it is escaped.
  const chargeText = (text: string) => {
    if (checking) return;
    if (text.length + 2 > bounds.bytes - bytes) throw new PastByteBound();
    charge(Buffer.byteLength(JSON.stringify(text)));
  };
  const visit = (item: unknown, depth: number): JsonValue => {
    if (++nodes > bounds.nodes || depth > bounds.depth)
      throw new RangeError("JSON exceeds depth/node limits");
    if (item === null || typeof item === "boolean") {
      charge(item === false ? 5 : 4);
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      charge(JSON.stringify(item).length);
      return item;
    }
    if (typeof item === "string" && text(item)) {
      chargeText(item);
      return item;
    }
    if (!item || typeof item !== "object" || ancestors.has(item))
      throw new TypeError("Expected finite JSON without cycles or invalid Unicode");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        // Each element is a value: an array longer than the values left is refused before its
        // keys are listed.
        if (item.length > bounds.nodes - nodes)
          throw new RangeError("JSON exceeds depth/node limits");
        if (Object.keys(item).length !== item.length)
          throw new TypeError("Sparse/extended arrays are not JSON");
        charge(item.length ? item.length + 1 : 2);
        return item.map((entry) => visit(entry, depth + 1));
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new TypeError("JSON objects must be plain objects");
      if (Object.getOwnPropertySymbols(item).length)
        throw new TypeError("JSON cannot contain symbol properties");
      const result: Record<string, JsonValue> = Object.create(null);
      // Each member is a value: an object with more than the values left is refused before its
      // keys are sorted.
      const keys = Object.keys(item);
      if (keys.length > bounds.nodes - nodes)
        throw new RangeError("JSON exceeds depth/node limits");
      if (!checking) {
        // Keys whose JSON text alone (at least their code points, two quotes and a colon each)
        // needs more bytes than are left pass the byte bound before they are sorted, as in the
        // Python SDK, so both read such an object the same way. A key has at least half its
        // UTF-16 length in code points, so a long one passes it without counting them.
        let left = bounds.bytes - bytes;
        for (const key of keys) {
          left -= 3;
          if (key.length / 2 > left) throw new PastByteBound();
          left -= codePoints(key);
          if (left < 0) throw new PastByteBound();
        }
        keys.sort();
      }
      charge(keys.length ? keys.length + 1 : 2);
      for (const key of keys) {
        if (!text(key))
          throw new TypeError("Expected finite JSON without cycles or invalid Unicode");
        chargeText(key);
        charge(1);
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor)) throw new TypeError("JSON cannot contain accessors");
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      // Repeated siblings serialize independently; only an active ancestor is a cycle.
      ancestors.delete(item);
    }
  };
  try {
    const result = visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(result)) > bounds.bytes)
      throw new RangeError("JSON exceeds byte limit");
    return result;
  } catch (error) {
    if (!(error instanceof PastByteBound)) throw error;
  }
  // The byte bound is checked last, as it was before the length was counted as the value is
  // read: a value past it that holds a value that is not JSON, or passes the value or depth bound,
  // is refused for that. So the value is read again with each object's keys in their own order,
  // and nothing is counted, escaped or sorted, nor text checked twice (`text`).
  checking = true;
  nodes = 0;
  visit(value, 0);
  throw new RangeError("JSON exceeds byte limit");
}
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(json(value, aggregateBounds(8 * 1024 * 1024))))
    .digest("hex");
}
/** SHA-256 hex digest of scorer source, as declared in a `local_code` definition. */
export function sourceDigest(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}
export function uuid(value: string): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new TypeError("Expected a UUID");
  return value;
}
