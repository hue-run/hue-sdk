function validText(value: string): boolean {
  return value.isWellFormed() && !value.includes("\u0000");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function environmentJson(
  value: unknown,
  maxBytes = 200_000,
  maxDepth = 32,
  maxNodes = 20_000,
): void {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > maxNodes || current.depth > maxDepth)
      throw new RangeError("Environment JSON exceeds depth/node limits");
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (typeof item === "string" && validText(item)) continue;
    if (!item || typeof item !== "object" || seen.has(item))
      throw new TypeError("Expected finite environment JSON without cycles or invalid Unicode");
    seen.add(item);
    const keys = Object.keys(item);
    if (Array.isArray(item)) {
      if (keys.length !== item.length) throw new TypeError("Sparse/extended arrays are not JSON");
    } else if (
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new TypeError("Environment JSON objects must be plain objects");
    if (Object.getOwnPropertySymbols(item).length)
      throw new TypeError("Environment JSON cannot contain symbol properties");
    for (const key of keys) {
      if (!validText(key)) throw new TypeError("Invalid environment JSON key");
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in descriptor))
        throw new TypeError("Environment JSON cannot contain accessors");
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes)
    throw new RangeError("Environment JSON exceeds byte limit");
}
export function validateEvidenceWorld(value: unknown): void {
  environmentJson(value, 200_000, 35, 200_000);
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.collections))
    throw new TypeError("Expected an environment world");
  const collections = Object.entries(value.collections);
  if (collections.length > 64) throw new RangeError("Environment world exceeds 64 collections");
  let entities = 0;
  for (const [name, entries] of collections) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !record(entries))
      throw new TypeError("Invalid environment collection");
    for (const [id, entity] of Object.entries(entries)) {
      if (++entities > 2000) throw new RangeError("Environment world exceeds 2000 entities");
      if (!id.length || id.length > 200 || id === "__proto__" || !record(entity))
        throw new TypeError("Invalid environment entity");
      environmentJson(entity);
    }
  }
}
export function validateEvidenceArguments(value: unknown): void {
  environmentJson(value, 256 * 1024, 33, 256 * 1024);
  if (!record(value)) throw new TypeError("Expected environment argument object");
  for (const [name, argument] of Object.entries(value)) {
    if (!name.length || name.length > 64) throw new TypeError("Invalid environment argument name");
    environmentJson(argument);
  }
}
