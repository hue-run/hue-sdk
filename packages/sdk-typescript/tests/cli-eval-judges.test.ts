import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dispatchPinnedJudges } from "../src/cli/eval.js";
import { createEvaluationClient } from "../src/evals.js";

function standIn(
  options: {
    count?: number;
    noOutput?: boolean;
    judges?: boolean;
    blocked?: boolean;
    retry?: boolean;
  } = {},
) {
  const experimentId = randomUUID(),
    runId = randomUUID();
  const judgeIds: string[] = [randomUUID(), randomUUID()];
  const cursor = randomUUID();
  const subjects = Array.from({ length: options.count ?? 1 }, () => randomUUID());
  const items = subjects.map((subjectId) => ({
    id: randomUUID(),
    subjectId,
    hasOutput: !options.noOutput,
    traceSnapshotId: null,
  }));
  const jobs: {
    key: string;
    body: string;
    runId: string;
    pairs: { evaluationItemId: string; scorerVersionId: string }[];
  }[] = [];
  let reverse = false,
    budgetReads = 0,
    postAttempts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === `/api/v1/experiments/${experimentId}`) {
        const versions = [
          ...["local_code", "world_judge", "manual", "builtin", "hosted_code"].map((kind) => ({
            id: randomUUID(),
            definition: { kind },
          })),
          ...(options.judges === false
            ? []
            : [...judgeIds, judgeIds[0]].map((id) => ({ id, definition: { kind: "llm_judge" } }))),
        ];
        return Response.json({
          id: experimentId,
          evaluation: { id: runId, scorerVersions: reverse ? versions.reverse() : versions },
        });
      }
      if (path === `/api/v1/evaluation-runs/${runId}/items`) {
        const ordered = reverse ? [...items].reverse() : items;
        // Deliberately overlap the page boundary and include an unrelated subject.
        const after = url.searchParams.get("after");
        return Response.json(
          after
            ? { items: ordered.slice(1), nextCursor: null }
            : {
                items: [
                  ...ordered.slice(0, 2),
                  { id: randomUUID(), subjectId: randomUUID(), hasOutput: true },
                ],
                nextCursor: cursor,
              },
        );
      }
      if (path === "/api/v1/judge-budget") {
        budgetReads++;
        return Response.json({
          configured: true,
          enabled: true,
          blocked: options.blocked ?? false,
        });
      }
      if (path === `/api/v1/evaluation-runs/${runId}/judge-jobs`) {
        const body = await request.text();
        const parsed = JSON.parse(body) as {
          idempotencyKey: string;
          jobs: { evaluationItemId: string; scorerVersionId: string }[];
        };
        if (options.blocked) return new Response(null, { status: 402 });
        jobs.push({ key: parsed.idempotencyKey, body, runId, pairs: parsed.jobs });
        if (options.retry && postAttempts++ === 0) return new Response(null, { status: 503 });
        return Response.json({ ids: parsed.jobs.map(() => randomUUID()) });
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    experimentId,
    runId,
    judgeIds,
    subjects,
    items,
    jobs,
    client: createEvaluationClient({
      apiKey: "synthetic-judge-dispatch-key",
      baseUrl: `http://127.0.0.1:${server.port}`,
      maxAttempts: 2,
    }),
    reverse: () => {
      reverse = !reverse;
    },
    budgetReads: () => budgetReads,
    stop: () => server.stop(true),
  };
}

describe("CLI hosted judge dispatch", () => {
  test.each([{ noOutput: true }, { judges: false }])(
    "requests no jobs when nothing is eligible: %j",
    async (options) => {
      const f = standIn(options);
      try {
        expect(await dispatchPinnedJudges(f.client, f.experimentId, f.subjects)).toBe(0);
        expect(f.budgetReads()).toBe(0);
        expect(f.jobs).toEqual([]);
      } finally {
        f.stop();
      }
    },
  );

  test("deduplicates pins and pages, chunks100 pairs, and replays exact keys and bodies", async () => {
    const f = standIn({ count: 103 });
    try {
      expect(await dispatchPinnedJudges(f.client, f.experimentId, f.subjects)).toBe(206);
      const first = structuredClone(f.jobs);
      expect(first.map((job) => job.pairs.length)).toEqual([100, 100, 6]);
      expect(first.every((job) => job.runId === f.runId && job.key.length <= 128)).toBe(true);
      const pairs = first.flatMap((job) => job.pairs);
      expect(
        new Set(pairs.map((pair) => `${pair.evaluationItemId}:${pair.scorerVersionId}`)).size,
      ).toBe(206);
      expect(
        pairs.every(
          (pair) =>
            f.judgeIds.includes(pair.scorerVersionId) &&
            f.items.some((item) => item.id === pair.evaluationItemId),
        ),
      ).toBe(true);
      f.reverse();
      expect(await dispatchPinnedJudges(f.client, f.experimentId, [...f.subjects].reverse())).toBe(
        206,
      );
      expect(f.jobs.slice(3)).toEqual(first);
    } finally {
      f.stop();
    }
  });

  test("server budget admission refuses new jobs with a clear error", async () => {
    const f = standIn({ blocked: true });
    try {
      await expect(dispatchPinnedJudges(f.client, f.experimentId, f.subjects)).rejects.toThrow(
        "check its judge budget",
      );
      expect(f.jobs).toEqual([]);
      expect(f.budgetReads()).toBe(0);
    } finally {
      f.stop();
    }
  });

  test("an ambiguous mutation retry sends the identical idempotent body", async () => {
    const f = standIn({ retry: true });
    try {
      expect(await dispatchPinnedJudges(f.client, f.experimentId, f.subjects)).toBe(2);
      expect(f.jobs).toHaveLength(2);
      expect(f.jobs[1]).toEqual(f.jobs[0]);
    } finally {
      f.stop();
    }
  });

  test("an interrupted CLI requests no further jobs", async () => {
    const f = standIn();
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    try {
      await expect(
        dispatchPinnedJudges(f.client, f.experimentId, f.subjects, controller.signal),
      ).rejects.toThrow("Stopped");
      expect(f.jobs).toEqual([]);
    } finally {
      f.stop();
    }
  });
});
