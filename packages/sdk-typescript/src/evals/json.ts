import { createHash } from "node:crypto";
import type { JsonValue } from "../types.js";

/** Reject lossy JSON serialization before creating requests/checkpoints. */
export function json(value: unknown, maxBytes = 200_000): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): JsonValue => {
    if (++nodes > 20_000 || depth > 32) throw new RangeError("JSON exceeds depth/node limits");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string" && item.isWellFormed() && !item.includes("\u0000")) return item;
    if (!item || typeof item !== "object" || ancestors.has(item))
      throw new TypeError("Expected finite JSON without cycles or invalid Unicode");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length)
          throw new TypeError("Sparse/extended arrays are not JSON");
        return item.map((entry) => visit(entry, depth + 1));
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new TypeError("JSON objects must be plain objects");
      if (Object.getOwnPropertySymbols(item).length)
        throw new TypeError("JSON cannot contain symbol properties");
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        visit(key, depth + 1);
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
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    throw new RangeError("JSON exceeds byte limit");
  return result;
}
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(json(value, 8 * 1024 * 1024)))
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
