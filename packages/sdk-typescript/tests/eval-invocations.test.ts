import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createEvaluationClient, HueApiError, type EvalInvocation } from "../src/evals.js";

function invocation(): EvalInvocation {
  return {
    id: randomUUID(),
    runId: randomUUID(),
    runUrl: "https://example.com/run",
    deadlineAt: "2026-12-01T00:00:00Z",
    state: "active",
    receipt: null,
    manifest: {
      version: 1,
      digest: "a".repeat(64),
      evalSetId: randomUUID(),
      evalSetVersionId: randomUUID(),
      scoringRunId: randomUUID(),
      config: {},
      policy: { thresholds: [] },
      cases: [],
      evaluators: [],
      baselineRunId: null,
    },
  };
}

describe("eval invocation client", () => {
  test("retries safe control operations with original bytes and reads by encoded identity", async () => {
    const saved = invocation();
    const calls: { method: string; path: string; body: string }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls.push({
          method: request.method,
          path: new URL(request.url).pathname + new URL(request.url).search,
          body: await request.text(),
        });
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-key");
        if (calls.length === 1) return new Response(null, { status: 503 });
        return Response.json({ invocation: saved });
      },
    });
    try {
      const client = createEvaluationClient({
        apiKey: "synthetic-key",
        baseUrl: server.url.origin,
      });
      expect(
        await client.createEvalInvocation({
          idempotencyKey: "stable",
          deadlineAt: saved.deadlineAt,
          evalSetId: saved.manifest.evalSetId,
        }),
      ).toEqual(saved);
      expect(calls[0]).toEqual(calls[1]);
      expect(await client.getEvalInvocationByKey("stable /?")).toEqual(saved);
      expect(calls.at(-1)?.path).toBe("/api/v1/eval-invocations?idempotencyKey=stable%20%2F%3F");
      expect(await client.getEvalInvocation(saved.runId)).toEqual(saved);
      expect(calls.at(-1)?.method).toBe("GET");
      expect(calls.at(-1)?.body).toBe("");
      const ci = { provider: "local", commitSha: "base-revision" } as const;
      expect(await client.createEvalBaseline(saved.id, { idempotencyKey: "base", ci })).toEqual(
        saved,
      );
      expect(calls.at(-1)?.path).toBe(`/api/v1/eval-invocations/${saved.id}/baseline`);
      expect(JSON.parse(calls.at(-1)!.body)).toEqual({ idempotencyKey: "base", ci });
    } finally {
      server.stop(true);
    }
  });

  test.each(["pass", "fail", "incomplete", "error", "cancelled"] as const)(
    "preserves the server's %s receipt",
    async (verdict) => {
      const saved = invocation();
      saved.state = "finalized";
      saved.receipt = {
        id: randomUUID(),
        manifestDigest: saved.manifest.digest,
        runId: saved.runId,
        scoringRunId: saved.manifest.scoringRunId,
        verdict,
        finalizedAt: "2026-11-04T00:00:00Z",
        executionIds: [],
        results: [],
        reasons: [],
      };
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return Response.json({ invocation: saved });
        },
      });
      try {
        const client = createEvaluationClient({
          apiKey: "synthetic-key",
          baseUrl: server.url.origin,
        });
        expect(
          (await client.finalizeEvalInvocation(saved.id, { idempotencyKey: "finalize" })).receipt,
        ).toEqual(saved.receipt);
        expect(
          (
            await client.cancelEvalInvocation(saved.id, {
              idempotencyKey: "cancel",
              reason: "deadline",
            })
          ).receipt,
        ).toEqual(saved.receipt);
      } finally {
        server.stop(true);
      }
    },
  );

  test("rejects invalid selections before sending and malformed responses", async () => {
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++;
        return Response.json({ invocation: { ...invocation(), state: "success" } });
      },
    });
    try {
      const client = createEvaluationClient({
        apiKey: "synthetic-key",
        baseUrl: server.url.origin,
      });
      await expect(
        client.createEvalInvocation({ idempotencyKey: "x", deadlineAt: "2026-12-01T00:00:00Z" }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      await expect(client.getEvalInvocation(randomUUID())).rejects.toBeInstanceOf(HueApiError);
    } finally {
      server.stop(true);
    }
  });

  test("rejects a gate receipt for a different frozen manifest", async () => {
    const saved = invocation();
    saved.receipt = {
      id: randomUUID(),
      manifestDigest: "different",
      runId: saved.runId,
      scoringRunId: saved.manifest.scoringRunId,
      verdict: "pass",
      finalizedAt: "2026-11-04T00:00:00Z",
      executionIds: [],
      results: [],
      reasons: [],
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ invocation: saved }),
    });
    try {
      const client = createEvaluationClient({
        apiKey: "synthetic-key",
        baseUrl: server.url.origin,
      });
      await expect(client.getEvalInvocation(saved.id)).rejects.toBeInstanceOf(HueApiError);
    } finally {
      server.stop(true);
    }
  });
});
