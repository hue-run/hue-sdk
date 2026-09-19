import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CaptureSession } from "../src/capture.js";
import { createHash } from "node:crypto";
import { canonicalCaptureJson as canonical } from "../src/capture.js";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
import type { StateEvidence } from "../src/capture.js";
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/capture-v1.json", import.meta.url), "utf8"),
);
const binding = {
  id: "gmail",
  kind: "tool" as const,
  contractVersion: "1",
  operations: [{ name: "read", inputSchema: { type: "object" } }],
};
function receiver() {
  const calls: { path: string; body: any; authorization: string | null }[] = [],
    receipts = new Map<string, number>(),
    finalized = new Map<number, { body: any; result: any }>();
  let revision = 0,
    failAppendOnce = false;
  let failFinalizeOnce: "before" | "after" | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname,
        body = request.method === "GET" ? null : ((await request.json()) as any);
      calls.push({ path, body, authorization: request.headers.get("authorization") });
      if (path === "/api/v1/captures")
        return Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          captureRevision: revision,
        });
      if (path.endsWith("/append")) {
        if (!receipts.has(body.idempotencyKey)) receipts.set(body.idempotencyKey, ++revision);
        if (failAppendOnce) {
          failAppendOnce = false;
          return new Response("unavailable", { status: 503 });
        }
        return Response.json({ captureRevision: receipts.get(body.idempotencyKey) });
      }
      if (path.endsWith("/finalize")) {
        const fail = failFinalizeOnce;
        failFinalizeOnce = undefined;
        if (fail === "before") return new Response("unavailable", { status: 503 });
        const prior = finalized.get(body.expectedCaptureRevision);
        if (prior)
          return canonical(prior.body) === canonical(body)
            ? Response.json(prior.result)
            : new Response("conflict", { status: 409 });
        if (body.expectedCaptureRevision !== revision)
          return new Response("stale", { status: 409 });
        const result = {
          revision: body.expectedCaptureRevision,
          digest: "a".repeat(64),
          omissions: body.producers.flatMap((p: any) =>
            p.dropped ? [{ code: "dropped", message: "records dropped" }] : [],
          ),
        };
        finalized.set(body.expectedCaptureRevision, { body, result });
        return fail === "after"
          ? new Response("acknowledgement lost", { status: 503 })
          : Response.json(result);
      }
      return Response.json({ captureRevision: revision });
    },
  });
  return {
    calls,
    baseUrl: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
    failFinalize: (when: "before" | "after") => {
      failFinalizeOnce = when;
    },
    failAppend: () => {
      failAppendOnce = true;
    },
  };
}
const options = (baseUrl: string) => ({
  sourceContent: true,
  apiKey: "synthetic-key",
  baseUrl,
  bindings: [binding],
  externalTraceId: "a".repeat(32),
});
describe("opt-in portable capture SDK", () => {
  test("canonical records match public cross-language fixtures", () => {
    for (const value of fixtures.canonical) expect(canonical(value.value)).toBe(value.canonical);
    for (const value of fixtures.matching)
      expect(sha256(canonical(value.arguments))).toBe(value.sha256);
  });
  test("capture disabled never exports and preserves the live object", async () => {
    const r = receiver();
    try {
      const session = new CaptureSession({ ...options(r.baseUrl), sourceContent: false });
      const result = { value: 42 };
      expect(await session.observe("gmail", "read", {}, async () => result)).toBe(result);
      expect((await session.finalize()).status).toBe("disabled");
      expect(r.calls).toEqual([]);
    } finally {
      r.close();
    }
  });
  test("pins sanitized snapshots and tool evidence without changing live returns or errors", async () => {
    const r = receiver();
    try {
      const session = new CaptureSession(options(r.baseUrl));
      session.stateEvidence(fixtures.stateEvidence as StateEvidence);
      const result = { body: "hello", access_token: "synthetic-private" };
      expect(
        await session.observe(
          "gmail",
          "read",
          { id: "m1", password: "synthetic-password" },
          async () => result,
        ),
      ).toBe(result);
      const failure = new Error("synthetic-private-error");
      let caught: unknown;
      try {
        await session.observe("gmail", "read", { id: "m2" }, async () => {
          throw failure;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      const report = await session.finalize();
      expect(report.status).toBe("finalized");
      expect(report.pending).toBe(0);
      const body = r.calls.find((c) => c.path.endsWith("/append"))!.body;
      expect(body.stateEvidence).toEqual([fixtures.stateEvidence]);
      expect(body.observations).toHaveLength(4);
      expect(body.observations[0].arguments.value).toEqual({ id: "m1" });
      expect(body.observations[1].result.value).toEqual({ body: "hello" });
      expect(body.observations[1].replayable).toBe(false);
      expect(JSON.stringify(r.calls)).not.toContain("synthetic-private");
      expect(JSON.stringify(r.calls)).not.toContain("synthetic-password");
      expect(r.calls.every((c) => c.authorization === "Bearer synthetic-key")).toBe(true);
    } finally {
      r.close();
    }
  });
  test("unknown append acknowledgement retries identical bytes and identity", async () => {
    const r = receiver();
    try {
      const session = new CaptureSession(options(r.baseUrl));
      await session.observe("gmail", "read", {}, async () => ({ id: "m1" }));
      r.failAppend();
      expect((await session.flush()).status).toBe("failed");
      expect((await session.flush()).pending).toBe(0);
      const appends = r.calls.filter((c) => c.path.endsWith("/append"));
      expect(appends[0].body).toEqual(appends[1].body);
    } finally {
      r.close();
    }
  });
  test("queue pressure and unsupported values become truthful omissions", async () => {
    const r = receiver();
    try {
      const session = new CaptureSession({ ...options(r.baseUrl), maxQueueRecords: 1 });
      const result = new Map([["key", "value"]]);
      expect(await session.observe("gmail", "read", {}, async () => result)).toBe(result);
      const report = await session.finalize();
      expect(report.dropped).toBe(1);
      expect(r.calls.find((c) => c.path.endsWith("/finalize"))!.body.producers[0]).toMatchObject({
        lastSequence: 2,
        dropped: 1,
        pending: 0,
      });
      const broken = new CaptureSession({
        ...options(r.baseUrl),
        redact: () => {
          throw new Error("bad redactor");
        },
      });
      expect(await broken.observe("gmail", "read", {}, async () => 42)).toBe(42);
      expect((await broken.finalize()).dropped).toBe(1);
    } finally {
      r.close();
    }
  });
  test("open calls remain pending in a finalized revision and can produce later evidence", async () => {
    const r = receiver();
    try {
      const session = new CaptureSession(options(r.baseUrl));
      let finish!: (value: number) => void;
      const live = session.observe(
        "gmail",
        "read",
        {},
        () =>
          new Promise<number>((resolve) => {
            finish = resolve;
          }),
      );
      const first = await session.finalize();
      expect(first.pending).toBe(1);
      finish(7);
      expect(await live).toBe(7);
      const second = await session.finalize();
      expect(second.pending).toBe(0);
      expect(second.revision!).toBeGreaterThan(first.revision!);
    } finally {
      r.close();
    }
  });
});

test("in-place custom redaction is retained as an omission for calls and snapshots", async () => {
  const r = receiver();
  try {
    const capture = new CaptureSession({
      ...options(r.baseUrl),
      redact: (value) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if ("body" in value) delete value.body;
          if (value.kind === "initial_snapshot") value.accountId = "reviewed-redaction";
        }
        return value;
      },
    });
    const initial = structuredClone(fixtures.stateEvidence) as StateEvidence;
    capture.stateEvidence(initial);
    const live = { body: "private-source", id: "message" };
    expect(await capture.observe("gmail", "read", { id: "message" }, async () => live)).toBe(live);
    expect(live.body).toBe("private-source");
    expect(initial.accountId).toBe("mailbox-example");
    expect((await capture.finalize()).status).toBe("finalized");
    const append = r.calls.find((call) => call.path.endsWith("/append"))!.body;
    expect(append.observations[1].omissionReason).toBe("redacted_result");
    expect(append.observations[1].replayable).toBe(false);
    expect(append.stateEvidence[0].boundary.omissions).toEqual(["credential_redaction"]);
  } finally {
    r.close();
  }
});

test("oversized live values remain live while capture avoids serializing their bodies", async () => {
  const r = receiver();
  try {
    const capture = new CaptureSession(options(r.baseUrl)),
      live = { body: "x".repeat(2 * 1024 * 1024) };
    expect(await capture.observe("gmail", "read", {}, async () => live)).toBe(live);
    expect((await capture.finalize()).status).toBe("finalized");
    const append = r.calls.find((call) => call.path.endsWith("/append"))!.body;
    expect(append.observations[1].omissionReason).toBe("unsupported_result");
    expect(append.observations[1].result).toBeUndefined();
  } finally {
    r.close();
  }
});

for (const failure of ["before", "after"] as const)
  test(`finalization recovers after ${failure}-acceptance failure and newer evidence`, async () => {
    const r = receiver();
    try {
      const capture = new CaptureSession(options(r.baseUrl));
      r.failFinalize(failure);
      expect((await capture.finalize()).status).toBe("failed");
      const first = r.calls.find((call) => call.path.endsWith("/finalize"))!.body;
      await capture.observe("gmail", "read", { id: "new" }, async () => ({ id: "new" }));
      const flushed = await capture.flush();
      expect(flushed.status).toBe("flushed");
      const report = await capture.finalize();
      expect(report.status).toBe("finalized");
      expect(report.revision!).toBeGreaterThan(flushed.revision!);
      const finalizes = r.calls.filter((call) => call.path.endsWith("/finalize"));
      expect(finalizes[1].body).toEqual(first);
      expect(finalizes[2].body.producers[0].lastSequence).toBe(2);
    } finally {
      r.close();
    }
  });

test("source descriptors use custom redaction and report omitted metadata", async () => {
  const r = receiver();
  try {
    const capture = new CaptureSession({
      ...options(r.baseUrl),
      redact: (value) => {
        if (value && typeof value === "object" && !Array.isArray(value) && "relation" in value) {
          value.name = "redacted";
          value.uri = "urn:redacted";
          delete value.metadata;
        }
        return value;
      },
    });
    const source = {
      id: "source",
      content: "complete" as const,
      relation: "tool_source" as const,
      name: "private-name",
      uri: "https://example.test/private-source",
      metadata: { note: "private-note" },
    };
    capture.source(source);
    expect((await capture.finalize()).status).toBe("finalized");
    const recorded = r.calls.find((call) => call.path.endsWith("/append"))!.body.sources[0];
    expect(recorded).toEqual({
      id: "source",
      content: "partial",
      relation: "tool_source",
      name: "redacted",
      uri: "urn:redacted",
    });
    expect(source.name).toBe("private-name");
    expect(JSON.stringify(r.calls)).not.toContain("private-note");
    const broken = new CaptureSession({
      ...options(r.baseUrl),
      redact: () => {
        throw new Error("redactor failure");
      },
    });
    broken.source(source);
    expect((await broken.flush()).dropped).toBe(1);
  } finally {
    r.close();
  }
});
