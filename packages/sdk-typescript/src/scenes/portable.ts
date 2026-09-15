import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "./schema.json" with { type: "json" };
import type { Binding, JsonValue, Manifest, MissReason } from "./types.js";
export const INLINE_BYTES = 262144,
  ARTIFACT_BYTES = 25 * 1024 * 1024,
  MANIFEST_BYTES = 64 * 1024 * 1024;
export class SnapshotMissError extends Error {
  readonly code = "HUE_SNAPSHOT_MISS";
  constructor(
    readonly reason: MissReason,
    readonly bindingId = "",
    readonly operation = "",
  ) {
    super(`Snapshot miss: ${reason}`);
    this.name = "SnapshotMissError";
  }
}
export class RecordedToolError extends Error {
  constructor(
    readonly recordedType: string,
    readonly recordedCode?: JsonValue,
  ) {
    super(`Recorded source tool failed (${recordedType})`);
    this.name = "RecordedToolError";
  }
}
export class ScenesApiError extends Error {
  constructor(readonly status?: number) {
    super(
      status
        ? `Hue Scenes request failed (HTTP ${status})`
        : "Hue Scenes request failed",
    );
    this.name = "ScenesApiError";
  }
}
export function json(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (x: unknown, depth: number): JsonValue => {
    if (++nodes > 1000000 || depth > 64)
      throw new TypeError("Portable JSON limit exceeded");
    if (x === null || typeof x === "boolean") return x;
    if (
      typeof x === "number" &&
      Number.isFinite(x) &&
      (!Number.isInteger(x) || Number.isSafeInteger(x))
    )
      return Object.is(x, -0) ? 0 : x;
    if (typeof x === "string" && x.isWellFormed()) return x;
    if (!x || typeof x !== "object" || ancestors.has(x))
      throw new TypeError("Unsupported portable JSON");
    ancestors.add(x);
    try {
      if (Array.isArray(x)) {
        if (
          Object.keys(x).length !== x.length ||
          Object.getOwnPropertySymbols(x).length
        )
          throw new TypeError("Sparse array");
        return Array.from({ length: x.length }, (_, i) => {
          const d = Object.getOwnPropertyDescriptor(x, String(i));
          if (!d || !("value" in d))
            throw new TypeError("Accessors unsupported");
          return visit(d.value, depth + 1);
        });
      }
      if (
        Object.getPrototypeOf(x) !== Object.prototype &&
        Object.getPrototypeOf(x) !== null
      )
        throw new TypeError("Plain JSON required");
      if (Object.getOwnPropertySymbols(x).length)
        throw new TypeError("Symbol properties unsupported");
      const o: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.keys(x).sort()) {
        if (!key.isWellFormed()) throw new TypeError("Invalid Unicode");
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
export function requestKey(
  binding: Binding,
  operation: string,
  args: unknown,
): string {
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
  if (u.username || u.password)
    throw new TypeError("URL credentials unsupported");
  u.hash = "";
  for (const k of [...u.searchParams.keys()])
    if (isSecret(k)) u.searchParams.delete(k);
  return u.href;
}
export function cleanHeaders(
  headers: Headers | Record<string, string>,
  allow?: string[],
): Record<string, string> {
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers);
  return Object.fromEntries(
    entries
      .filter(
        ([k]) => !isSecret(k) && (!allow || allow.includes(k.toLowerCase())),
      )
      .map(([k, v]) => [k.toLowerCase(), v]),
  );
}
const ajv = new Ajv2020({ strict: false, allErrors: false });
const validate = ajv.compile(schema);
export function verifyManifest(input: unknown, digest: string): Manifest {
  if (!validate(input) || sha256(canonical(input)) !== digest)
    throw new SnapshotMissError("integrity");
  const m = input as Manifest;
  if (
    /^0+$/.test(m.externalTraceId) ||
    m.observations.length > 4000 ||
    new Set(m.bindings.map((b) => b.id)).size !== m.bindings.length
  )
    throw new SnapshotMissError("integrity");
  return deepFreeze(json(m)) as unknown as Manifest;
}
export function validateBindings(bindings: Binding[]): Binding[] {
  const result = json(bindings) as unknown as Binding[];
  const validateBinding = ajv.getSchema(`${schema.$id}#/$defs/binding`)!;
  for (const b of result) {
    if (!validateBinding(b)) throw new TypeError("Invalid scene binding");
    if (b.kind === "http") {
      if (!b.http) throw new TypeError("HTTP binding requires scope");
      const u = new URL(b.http.origin);
      if (
        u.origin !== b.http.origin ||
        u.username ||
        u.password ||
        !b.http.pathPrefix.startsWith("/")
      )
        throw new TypeError("Invalid HTTP scope");
      if (b.http.headers?.some(isSecret))
        throw new TypeError("Cannot select credential headers");
    }
  }
  if (new Set(result.map((b) => b.id)).size !== result.length)
    throw new TypeError("Duplicate binding");
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
