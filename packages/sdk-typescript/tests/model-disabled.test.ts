import { describe, expect, test } from "bun:test";
import { createHue } from "../src/index.js";

describe("model() on a disabled client", () => {
  test("runs the callback and records no instrumentation failure for invalid metadata", async () => {
    const hue = createHue({ enabled: false, captureContent: false });
    const result = await hue.model("", { provider: "", operation: " " }, async (span) => {
      span.setInput({ messages: [] });
      span.setUsage({ inputTokens: -1 });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(hue.transport.getReport().instrumentationFailures).toBe(0);
    expect((await hue.flushSafe()).ok).toBe(true);
    await hue.shutdownSafe();
  });

  test("still counts invalid metadata on an active client", async () => {
    const hue = createHue({
      apiKey: "hue_test_key",
      serviceName: "model-metadata",
      captureContent: false,
      baseUrl: "http://127.0.0.1:9",
    });
    await hue.model("", { provider: "synthetic" }, async () => "ok");
    expect(hue.transport.getReport().instrumentationFailures).toBe(1);
    await hue.shutdownSafe({ timeoutMillis: 200 });
  });
});
