import { expect, test } from "bun:test";
import { registryProxyUrl } from "../scripts/setup-registry-proxy.mjs";

test("test registry proxy never lets request paths select an authority", () => {
  for (const value of [
    "http://127.0.0.1/express?write=true",
    "https://unrelated.invalid/archive.tgz",
    "https://127.0.0.1//unrelated.invalid/archive.tgz",
    "custom:@unrelated.invalid/archive.tgz",
    "custom:\\unrelated.invalid/archive.tgz",
    "custom:?target=https://unrelated.invalid",
  ]) {
    const target = registryProxyUrl(new URL(value));
    expect(target.origin).toBe("https://registry.npmjs.org");
    expect(target.username).toBe("");
    expect(target.password).toBe("");
    expect(target.hash).toBe("");
  }
  const scoped = registryProxyUrl(new URL("http://127.0.0.1/@opentelemetry%2fapi?version=1.9.1"));
  expect(scoped.pathname).toBe("/@opentelemetry%2fapi");
  expect(scoped.search).toBe("?version=1.9.1");
});
