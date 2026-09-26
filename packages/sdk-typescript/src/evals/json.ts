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

/** Reject lossy JSON serialization before creating requests/checkpoints. */
export function json(value: unknown, requested: JsonBounds | number = valueBounds): JsonValue {
  const bounds = typeof requested === "number" ? { ...valueBounds, bytes: requested } : requested;
  const ancestors = new Set<object>();
  let nodes = 0;
  // The UTF-8 length of the JSON text, counted as the value is read, so a value too long to
  // serialize (past the runtime's longest string) is refused before `JSON.stringify` is asked to.
  let bytes = 0;
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > bounds.bytes) throw new RangeError("JSON exceeds byte limit");
  };
  // A string's JSON text is at least as long as the string, so one longer than what is left is
  // refused before it is escaped.
  const chargeText = (text: string) => {
    if (text.length + 2 > bounds.bytes - bytes) throw new RangeError("JSON exceeds byte limit");
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
    if (typeof item === "string" && isText(item)) {
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
      // Keys whose JSON text alone (at least their code points, two quotes and a colon each)
      // needs more bytes than are left are refused before they are sorted, as the Python SDK
      // refuses them, so both refuse such an object for the same reason. A key has at least
      // half its UTF-16 length in code points, so a long one is refused without counting them.
      let left = bounds.bytes - bytes;
      for (const key of keys) {
        left -= 3;
        if (key.length / 2 > left) throw new RangeError("JSON exceeds byte limit");
        left -= codePoints(key);
        if (left < 0) throw new RangeError("JSON exceeds byte limit");
      }
      keys.sort();
      charge(keys.length ? keys.length + 1 : 2);
      for (const key of keys) {
        if (!isText(key))
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
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > bounds.bytes)
    throw new RangeError("JSON exceeds byte limit");
  return result;
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
