import { copyFile } from "node:fs/promises";
import "./verify-conversion-scorer.mjs";

// Preserve the executable source bytes pinned by the scorer registration.
for (const file of ["conversion-outcome-core.mjs", "conversion-outcome-core.d.mts"]) {
  await copyFile(
    new URL(`../src/evals/${file}`, import.meta.url),
    new URL(`../dist/evals/${file}`, import.meta.url),
  );
}
