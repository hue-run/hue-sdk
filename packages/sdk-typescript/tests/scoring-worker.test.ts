import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvaluationClient,
  HueApiError,
  serveScoringJobs,
  type RescoreOptions,
  type RunnerReport,
  type ScoringJob,
} from "../src/evals.js";

const VERSION = "11111111-1111-4111-8111-111111111111";
const job = (n: number): ScoringJob => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  leaseToken: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  leaseExpiresAt: "2026-09-23T00:05:00.000Z",
  scoringId: "22222222-2222-4222-8222-222222222222",
  itemId: `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  evaluatorVersionId: VERSION,
  attempts: 1,
});

function fakeQueue(jobs: ScoringJob[]) {
  const queue = [...jobs];
  const calls = {
    claims: [] as number[],
    extended: [] as string[],
    completed: [] as string[],
    released: [] as { id: string; retryable: boolean; error: { type: string; message?: string } }[],
  };
  const client = {
    async claimScoringJobs(input: { evaluatorVersionIds: string[]; limit: number }) {
      expect(input.evaluatorVersionIds).toEqual([VERSION]);
      calls.claims.push(input.limit);
      return { jobs: queue.splice(0, input.limit) };
    },
    async extendScoringJob(id: string) {
      calls.extended.push(id);
      return { id, leaseExpiresAt: "2026-09-23T00:10:00.000Z" };
    },
    async completeScoringJob(id: string) {
      calls.completed.push(id);
      return { id, state: "completed" };
    },
    async releaseScoringJob(
      id: string,
      input: { retryable: boolean; error: { type: string; message?: string } },
    ) {
      calls.released.push({ id, retryable: input.retryable, error: input.error });
      return { id, state: input.retryable ? "queued" : "error" };
    },
  };
  return { client, calls, queue };
}
const report = (options: RescoreOptions): RunnerReport => ({
  runId: options.runId,
  subjectIds: [],
  resultIds: ["result"],
  deferredScorerVersionIds: [],
});
async function base(client: object) {
  return {
    client: client as never,
    scorers: [],
    evaluatorVersionIds: [VERSION],
    checkpointRoot: await mkdtemp(join(tmpdir(), "scoring-worker-")),
    persistResultContent: true,
    idleMillis: 5,
  };
}

describe("scoring workers", () => {
  test("score leased jobs at most `concurrency` at a time and complete each once", async () => {
    const { client, calls } = fakeQueue([1, 2, 3, 4, 5].map(job));
    let active = 0;
    let peak = 0;
    const scored: string[][] = [];
    const options = await base(client);
    const result = await serveScoringJobs({
      ...options,
      concurrency: 2,
      once: true,
      score: async (rescore) => {
        active += 1;
        peak = Math.max(peak, active);
        scored.push(rescore.itemIds ?? []);
        expect(rescore.runId).toBe(job(1).scoringId);
        expect(rescore.deferUnboundLocalScorers).toBe(true);
        // A job's working files live only while it runs.
        await mkdir(rescore.checkpointDirectory, { recursive: true });
        await writeFile(join(rescore.checkpointDirectory, "output.pdf"), "x");
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return report(rescore);
      },
    });
    expect(result).toEqual({ completed: 5, requeued: 0, failed: 0 });
    expect(peak).toBe(2);
    expect(calls.claims.every((limit) => limit <= 2)).toBe(true);
    expect(scored.map((items) => items.length)).toEqual([1, 1, 1, 1, 1]);
    expect(new Set(calls.completed).size).toBe(5);
    expect(calls.released).toEqual([]);
    for (const claimed of [1, 2, 3, 4, 5].map(job))
      await expect(stat(join(options.checkpointRoot, `job-${claimed.id}`))).rejects.toThrow();
  });

  test("failed jobs go back to the queue unless Hue refused the request, with no message", async () => {
    const { client, calls } = fakeQueue([job(1), job(2)]);
    const result = await serveScoringJobs({
      ...(await base(client)),
      once: true,
      score: async (rescore) => {
        if (rescore.itemIds?.[0] === job(1).itemId)
          throw new Error("grader crashed on NOMBRE DEL TRABAJADOR 1.234.567");
        throw new HueApiError(422);
      },
    });
    expect(result).toEqual({ completed: 0, requeued: 1, failed: 1 });
    expect(calls.released).toEqual([
      { id: job(1).id, retryable: true, error: { type: "Error" } },
      { id: job(2).id, retryable: false, error: { type: "HueApiError" } },
    ]);
    expect(calls.completed).toEqual([]);
  });

  test("a held lease is renewed until the job finishes", async () => {
    const { client, calls } = fakeQueue([job(1)]);
    await serveScoringJobs({
      ...(await base(client)),
      once: true,
      leaseSeconds: 30,
      renewMillis: 5,
      score: async (rescore) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return report(rescore);
      },
    });
    const renewals = calls.extended.length;
    expect(renewals).toBeGreaterThan(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.extended.length).toBe(renewals);
  });

  test("an abort stops claiming and finishes the jobs already held", async () => {
    const { client, calls, queue } = fakeQueue([1, 2, 3, 4].map(job));
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const loop = serveScoringJobs({
      ...(await base(client)),
      concurrency: 2,
      signal: controller.signal,
      score: async (rescore) => {
        await gate;
        return report(rescore);
      },
    });
    while (calls.claims.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    release();
    expect(await loop).toEqual({ completed: 2, requeued: 0, failed: 0 });
    expect(queue.length).toBe(2);
  });

  test("once returns immediately from an empty queue", async () => {
    const { client, calls } = fakeQueue([]);
    const result = await serveScoringJobs({
      ...(await base(client)),
      once: true,
      score: async () => {
        throw new Error("unused");
      },
    });
    expect(result).toEqual({ completed: 0, requeued: 0, failed: 0 });
    expect(calls.claims).toEqual([4]);
  });

  test("rejects limits outside the queue's contract", async () => {
    const { client } = fakeQueue([]);
    const options = await base(client);
    for (const concurrency of [0, 65, 1.5])
      await expect(serveScoringJobs({ ...options, concurrency })).rejects.toThrow(
        "concurrency must be 1–64",
      );
    await expect(serveScoringJobs({ ...options, leaseSeconds: 29 })).rejects.toThrow(
      "leaseSeconds must be 30–3600",
    );
    await expect(
      serveScoringJobs({ ...options, leaseSeconds: 30, renewMillis: 30_000 }),
    ).rejects.toThrow("renewMillis must be shorter than the lease");
  });
  test("the lease methods use the scoring-job HTTP contract", async () => {
    const requests: { method: string; path: string; body?: unknown }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-key");
        const url = new URL(request.url);
        const body = request.method === "POST" ? await request.json() : undefined;
        requests.push({ method: request.method, path: url.pathname + url.search, body });
        if (url.pathname.endsWith("/claim")) return Response.json({ jobs: [job(1)] });
        if (url.pathname.endsWith("/lease"))
          return Response.json({ id: job(1).id, leaseExpiresAt: job(1).leaseExpiresAt });
        if (url.pathname.endsWith("/stats"))
          return Response.json({
            queued: 1,
            running: 0,
            completed: 0,
            error: 0,
            skipped: 0,
            oldestQueuedAt: null,
          });
        return Response.json({ id: job(1).id, state: "completed" });
      },
    });
    const client = createEvaluationClient({
      apiKey: "synthetic-key",
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    try {
      const { id, leaseToken } = job(1);
      const claimed = await client.claimScoringJobs({
        evaluatorVersionIds: [VERSION],
        limit: 2,
        leaseSeconds: 60,
      });
      expect(claimed.jobs).toEqual([job(1)]);
      await client.extendScoringJob(id, { leaseToken, leaseSeconds: 60 });
      await client.completeScoringJob(id, { leaseToken });
      await client.releaseScoringJob(id, { leaseToken, retryable: true, error: { type: "Error" } });
      expect((await client.getScoringJobStats([VERSION])).queued).toBe(1);
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/api/v1/scoring-jobs/claim",
          body: { evaluatorVersionIds: [VERSION], limit: 2, leaseSeconds: 60 },
        },
        {
          method: "POST",
          path: `/api/v1/scoring-jobs/${id}/lease`,
          body: { leaseToken, leaseSeconds: 60 },
        },
        { method: "POST", path: `/api/v1/scoring-jobs/${id}/complete`, body: { leaseToken } },
        {
          method: "POST",
          path: `/api/v1/scoring-jobs/${id}/release`,
          body: { leaseToken, retryable: true, error: { type: "Error" } },
        },
        {
          method: "GET",
          path: `/api/v1/scoring-jobs/stats?evaluatorVersionId=${VERSION}`,
          body: undefined,
        },
      ]);
    } finally {
      server.stop(true);
    }
  });
  test("requests Hue refused with a short Retry-After are sent again; others fail at once", async () => {
    let busy = 2;
    const bodies: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/claim")) {
          bodies.push(await request.json());
          if (busy-- > 0)
            return Response.json(
              { error: "busy" },
              { status: 503, headers: { "Retry-After": "0" } },
            );
          return Response.json({ jobs: [] });
        }
        if (path.endsWith("/stats"))
          return Response.json(
            { error: "busy" },
            { status: 503, headers: { "Retry-After": "60" } },
          );
        return Response.json({ error: "unavailable" }, { status: 503 });
      },
    });
    const client = createEvaluationClient({
      apiKey: "synthetic-key",
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    try {
      const input = { evaluatorVersionIds: [VERSION], limit: 1, leaseSeconds: 60 };
      expect(await client.claimScoringJobs(input)).toEqual({ jobs: [] });
      expect(bodies).toEqual([input, input, input]);
      await expect(client.getScoringJobStats([VERSION])).rejects.toMatchObject({ status: 503 });
      await expect(
        client.completeScoringJob(job(1).id, { leaseToken: job(1).leaseToken }),
      ).rejects.toMatchObject({ status: 503 });
      busy = 10;
      bodies.length = 0;
      await expect(client.claimScoringJobs(input)).rejects.toMatchObject({ status: 503 });
      expect(bodies).toHaveLength(5);
    } finally {
      server.stop(true);
    }
  });
});
