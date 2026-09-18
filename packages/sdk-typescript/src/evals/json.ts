import { createHash } from "node:crypto";
import type { JsonValue } from "../types.js";

export type JsonBounds = { bytes: number; nodes: number; depth: number };
export const valueBounds: JsonBounds = { bytes: 200_000, nodes: 20_000, depth: 32 };
export function aggregateBounds(bytes: number): JsonBounds {
  return { bytes, nodes: Math.ceil(bytes / 2), depth: valueBounds.depth + 8 };
}
const isText = (item: string) => item.isWellFormed() && !item.includes("\u0000");

/** Reject lossy JSON serialization before creating requests/checkpoints. */
export function json(value: unknown, requested: JsonBounds | number = valueBounds): JsonValue {
  const bounds = typeof requested === "number" ? { ...valueBounds, bytes: requested } : requested;
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): JsonValue => {
    if (++nodes > bounds.nodes || depth > bounds.depth)
      throw new RangeError("JSON exceeds depth/node limits");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string" && isText(item)) return item;
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
        if (!isText(key))
          throw new TypeError("Expected finite JSON without cycles or invalid Unicode");
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
