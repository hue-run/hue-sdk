import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The driver exits 0 only once a media download connects to an address the check accepted.
// It exits non-zero while the check and the fetch resolve the name separately.
test("langfuse media is not fetched from a private address the check did not see", () => {
  const driver = join(dirname(fileURLToPath(import.meta.url)), "langfuse-media-rebind/driver.mjs");
  const result = spawnSync("node", [driver], { encoding: "utf8", timeout: 60_000 });
  expect(result.status, `${result.stdout ?? ""}\n${result.stderr ?? ""}`).toBe(0);
}, 60_000);
