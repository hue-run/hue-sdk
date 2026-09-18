import { createRequire } from "node:module";

/** Package version from package.json, shared by the instrumentation scope and the export User-Agent. */
export const sdkVersion = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;
