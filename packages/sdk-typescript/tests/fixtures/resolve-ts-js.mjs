import { existsSync } from "node:fs";

/** The SDK imports TypeScript sources with a .js suffix. Node's type transform
 * loads the file the specifier names, so a relative .js import whose sibling .ts
 * exists is loaded from that .ts file. Package imports are unchanged. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(candidate)) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
}
