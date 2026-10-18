import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HueWorldError, WorldModelClient, isTransientWorldError } from "../src/world.js";

const progress = {
  state: "processing_limit" as const,
  selectedEvidenceCutoff: 1,
  retainedEvidenceCutoff: 2,
  readyEvidenceCutoff: 1,
  pendingEvidence: true,
};
test("terminal World failures expose only bounded progress and do not retry identical input", async () => {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      calls++;
      return Response.json(
        { error: "private body", preparation: { ...progress, private: "private body" } },
        { status: 503, headers: { "X-Hue-Diagnostic": "world_processing_limit" } },
      );
    },
  });
  try {
    const client = new WorldModelClient({
      apiKey: "synthetic-readiness-key",
      baseUrl: server.url.origin,
      maxAttempts: 4,
    });
    const error = await client
      .startInstance(randomUUID(), { at: "2026-10-17T00:00:00Z", idempotencyKey: "same" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HueWorldError);
    if (!(error instanceof HueWorldError)) throw new Error("Expected World refusal");
    expect(error.preparation).toEqual(progress);
    expect(error.message).not.toContain("private body");
    expect(isTransientWorldError(error)).toBe(false);
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("oversized or invalid World error metadata is discarded", async () => {
  for (const body of [
    { preparation: { ...progress, readyEvidenceCutoff: -1 } },
    { preparation: { ...progress, state: "ready" } },
    { preparation: progress, error: "private".repeat(4000) },
  ]) {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json(body, {
          status: 503,
          headers: { "X-Hue-Diagnostic": "world_processing_limit" },
        });
      },
    });
    try {
      const client = new WorldModelClient({
        apiKey: "synthetic-readiness-key",
        baseUrl: server.url.origin,
      });
      const error = await client
        .startInstance(randomUUID(), { at: "2026-10-17T00:00:00Z", idempotencyKey: "same" })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(HueWorldError);
      if (error instanceof HueWorldError) expect(error.preparation).toBeUndefined();
    } finally {
      server.stop(true);
    }
  }
});
