import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/evals/conversion-outcome-core.mjs", import.meta.url));
const declaration = await readFile(
  new URL("../src/evals/conversion-outcomes.ts", import.meta.url),
  "utf8",
);
const actual = createHash("sha256").update(source).digest("hex");
if (!declaration.includes(`sourceDigest: "${actual}"`))
  throw new Error(
    "Conversion scorer source changed: update its declared sourceDigest before publishing the SDK",
  );
