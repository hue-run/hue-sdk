import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { sdkVersion } from "../src/version.js";

describe("sdkVersion", () => {
  test("matches package.json so a release cannot ship a stale literal", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(sdkVersion).toBe(pkg.version);
  });
});
