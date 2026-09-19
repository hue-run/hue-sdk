import { createHash } from "node:crypto";
import type { Binding, JsonValue } from "./types.js";
export function json(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const reserve = (size: number) => {
    bytes += size;
    if (bytes > 1024 * 1024) throw new RangeError("Portable JSON exceeds byte limit");
  };
  const visit = (x: unknown, depth: number): JsonValue => {
    if (++nodes > 100000 || depth > 40) throw new TypeError("Portable JSON limit exceeded");
    reserve(8);
    if (x === null || typeof x === "boolean") return x;
    if (
      typeof x === "number" &&
      Number.isFinite(x) &&
      (!Number.isInteger(x) || Number.isSafeInteger(x))
    )
      return Object.is(x, -0) ? 0 : x;
    if (typeof x === "string") {
      if (x.length > 1024 * 1024) throw new RangeError("Portable string exceeds byte limit");
      reserve(Buffer.byteLength(x));
      if (x.isWellFormed() && !x.includes("\u0000")) return x;
    }
    if (!x || typeof x !== "object" || ancestors.has(x))
      throw new TypeError("Unsupported portable JSON");
    ancestors.add(x);
    try {
      if (Array.isArray(x)) {
        if (Object.keys(x).length !== x.length || Object.getOwnPropertySymbols(x).length)
          throw new TypeError("Sparse array");
        return Array.from({ length: x.length }, (_, i) => {
          const d = Object.getOwnPropertyDescriptor(x, String(i));
          if (!d || !("value" in d)) throw new TypeError("Accessors unsupported");
          return visit(d.value, depth + 1);
        });
      }
      if (Object.getPrototypeOf(x) !== Object.prototype && Object.getPrototypeOf(x) !== null)
        throw new TypeError("Plain JSON required");
      if (Object.getOwnPropertySymbols(x).length)
        throw new TypeError("Symbol properties unsupported");
      const o: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.keys(x).sort()) {
        if (key.length > 1024 * 1024) throw new RangeError("Portable key exceeds byte limit");
        reserve(Buffer.byteLength(key) + 3);
        if (!key.isWellFormed() || key.includes("\u0000")) throw new TypeError("Invalid Unicode");
        const d = Object.getOwnPropertyDescriptor(x, key)!;
        if (!("value" in d)) throw new TypeError("Accessors unsupported");
        o[key] = visit(d.value, depth + 1);
      }
      return o;
    } finally {
      ancestors.delete(x);
    }
  };
  return visit(value, 0);
}
// Serialize members directly: JSON.stringify objects reorders integer-looking keys, unlike JCS.
/** Serialize bounded portable JSON with deterministic UTF-16 member ordering. */
export function canonical(value: unknown): string {
  const emit = (x: JsonValue): string =>
    Array.isArray(x)
      ? `[${x.map(emit).join(",")}]`
      : x !== null && typeof x === "object"
        ? `{${Object.keys(x)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${emit(x[k])}`)
            .join(",")}}`
        : JSON.stringify(x);
  return emit(json(value));
}
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Hash the binding identity, contract, operation and canonical arguments. */
export function requestKey(binding: Binding, operation: string, args: unknown): string {
  return sha256(
    canonical({
      bindingId: binding.id,
      operation,
      contractVersion: binding.contractVersion,
      arguments: args,
    }),
  );
}
const secrets = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "xapikey",
  "xauthtoken",
  "signature",
  "sig",
  "xamzsignature",
  "xamzcredential",
  "xamzsecuritytoken",
  "xgoogsignature",
  "xgoogcredential",
]);
export function isSecret(key: string): boolean {
  return secrets.has(key.toLowerCase().replace(/[-_]/g, ""));
}
export function sanitize(value: unknown): {
  value: JsonValue;
  changed: boolean;
} {
  let changed = false;
  const walk = (x: JsonValue): JsonValue => {
    if (typeof x === "string" && /^https?:\/\//i.test(x)) {
      try {
        const safe = cleanUrl(x);
        if (safe !== x) {
          changed = true;
          return safe;
        }
      } catch {
        changed = true;
        return "[redacted-url]";
      }
    }
    return Array.isArray(x)
      ? x.map(walk)
      : x !== null && typeof x === "object"
        ? Object.fromEntries(
            Object.entries(x).flatMap(([k, v]) => {
              if (isSecret(k)) {
                changed = true;
                return [];
              }
              return [[k, walk(v)]];
            }),
          )
        : x;
  };
  return {
    value: walk(json(value)),
    get changed() {
      return changed;
    },
  };
}
export function cleanUrl(value: string): string {
  const u = new URL(value);
  u.username = "";
  u.password = "";
  u.hash = "";
  // Do not use URLSearchParams.delete: it re-encodes every remaining pair (%20 becomes +).
  const pairs = u.search
    .slice(1)
    .split("&")
    .filter((pair) => {
      const rawName = pair.split("=", 1)[0];
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, " "));
      } catch {
        // Retain malformed noncredential query names without decoding them.
      }
      return !isSecret(name);
    });
  u.search = pairs.join("&");
  return u.href;
}
