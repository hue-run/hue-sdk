import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHue } from "../src/index.js";
import { createEnvironmentClient } from "../src/environment.js";
import {
  builtins,
  createEvaluationClient,
  defineLocalScorer,
  HueApiError,
  registeredCapabilities,
  runExperiment,
  runLocalAgent,
  safeFilename,
  withFiles,
  rescore,
  type ArtifactUpload,
  type Completion,
  type Execution,
  type Experiment,
  type ExperimentCase,
  type JsonValue,
  type LocalFile,
  type Result,
  type ResultSummary,
  type ScorerVersion,
  type Subject,
  type SubjectFile,
} from "../src/evals.js";

const key = "synthetic-files-key";
const digest = "c".repeat(64);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const directory = () => mkdtemp(join(tmpdir(), "hue-files-"));
const version = (definition: ScorerVersion["definition"]): ScorerVersion => ({
  id: randomUUID(),
  contentDigest: digest,
  definition,
});

type StoredArtifact = {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  state: "reserved" | "ready";
  copyState: "none" | "started" | "acknowledged";
  bytes?: Uint8Array;
};

/** Synthetic control plane: one frozen case with pinned input files, artifacts and executions. */
function fixture(options: {
  scorers: ScorerVersion[];
  failReserveOnce?: boolean;
  failPutOnce?: boolean;
}) {
  const projectId = randomUUID();
  const datasetVersionId = randomUUID();
  const agentId = randomUUID();
  const localRunId = randomUUID();
  const inputs = {
    source: { id: randomUUID(), bytes: Buffer.from("incident report bytes") },
    template: { id: randomUUID(), bytes: Buffer.from("institutional template bytes") },
    evaluatorOnly: { id: randomUUID(), bytes: Buffer.from("organization template bytes") },
  };
  const item: ExperimentCase = {
    id: randomUUID(),
    datasetVersionId,
    externalKey: "letter-1",
    inputs: { query: "Draft the reply letter", topic: "warning" },
    hasExpected: false,
    metadata: { letter: { id: "letter-1" } },
    environmentVersionId: null,
    artifactManifestId: randomUUID(),
    inputFiles: [
      {
        artifactId: inputs.source.id,
        role: "source",
        filename: "Informe.docx",
        contentType: docx,
        byteSize: inputs.source.bytes.byteLength,
        sha256: sha256(inputs.source.bytes),
      },
      {
        artifactId: inputs.template.id,
        role: "attached_template",
        filename: "Plantilla.docx",
        contentType: docx,
        byteSize: inputs.template.bytes.byteLength,
        sha256: sha256(inputs.template.bytes),
      },
      {
        artifactId: inputs.evaluatorOnly.id,
        role: "org_template",
        filename: "Org.docx",
        contentType: docx,
        byteSize: inputs.evaluatorOnly.bytes.byteLength,
        sha256: sha256(inputs.evaluatorOnly.bytes),
      },
    ],
  };
  const experiment: Experiment = {
    id: randomUUID(),
    name: "documents",
    datasetVersionId,
    config: { variant: "baseline" },
    configDigest: digest,
    evaluation: {
      id: randomUUID(),
      name: "default",
      scorerVersions: options.scorers,
      itemCount: 1,
      scores: { scored: 0, error: 0, skipped: 0, pending: options.scorers.length },
    },
    caseCount: 1,
    finishedAt: null,
    execution: { unstarted: 1, started: 0, uncertain: 0, succeeded: 0, error: 0, cancelled: 0 },
  };
  const artifacts = new Map<string, StoredArtifact>();
  for (const [name, input] of Object.entries(inputs))
    artifacts.set(input.id, {
      id: input.id,
      filename: `${name}.docx`,
      contentType: docx,
      byteSize: input.bytes.byteLength,
      sha256: sha256(input.bytes),
      state: "ready",
      copyState: "acknowledged",
      bytes: input.bytes,
    });
  const reservations = new Map<string, string>();
  const executions = new Map<string, Execution>();
  const subjects = new Map<string, Subject>();
  const scoringRuns = new Map<
    string,
    {
      scorerVersions: ScorerVersion[];
      items: { id: string; subjectId: string; hasOutput: boolean; traceSnapshotId: null }[];
    }
  >();
  const storedResults = new Map<string, ResultSummary[]>();
  let conflictOnce: "winner" | "unrelated" | undefined;
  let environmentStatus = 503;
  const calls = {
    environmentReads: 0,
    downloads: [] as string[],
    reserves: 0,
    uploads: 0,
    completions: [] as Record<string, unknown>[],
    results: [] as Result[],
    localRun: [] as { state: string; failureType?: string }[],
    registrations: [] as Record<string, unknown>[],
  };
  let failReserve = options.failReserveOnce ?? false;
  let failPut = options.failPutOnce ?? false;
  let claimed = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/blob/")) {
        // Storage capability: the Hue key must never reach it.
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.method).toBe("PUT");
        if (failPut) {
          failPut = false;
          return new Response(null, { status: 500 });
        }
        const stored = artifacts.get(url.pathname.slice("/blob/".length))!;
        stored.bytes = new Uint8Array(await request.arrayBuffer());
        calls.uploads++;
        return Response.json({ ok: true });
      }
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      const path = url.pathname.replace("/api/v1", "");
      if (path === "/projects/current")
        return Response.json({
          id: projectId,
          name: "Synthetic",
          slug: "synthetic",
          organizationId: randomUUID(),
        });
      if (path.startsWith("/otlp/")) {
        await request.arrayBuffer();
        return new Response(new Uint8Array(), {
          headers: { "Content-Type": "application/x-protobuf" },
        });
      }
      const body =
        request.method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);
      if (path === "/local-agent-worker/register") {
        calls.registrations.push(body);
        return Response.json({
          id: agentId,
          ...body,
          enabled: true,
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      }
      if (path === "/local-agent-worker/claim") {
        if (claimed) return Response.json(null);
        claimed = true;
        return Response.json({ runId: localRunId, experimentId: experiment.id });
      }
      if (path === "/local-agent-worker/runs/heartbeat")
        return Response.json({ runId: localRunId, active: true });
      if (path === "/local-agent-worker/runs/complete") {
        calls.localRun.push({
          state: String(body.state),
          ...(body.failureType ? { failureType: String(body.failureType) } : {}),
        });
        return Response.json({ runId: localRunId, state: body.state });
      }
      const download = /^\/artifacts\/([^/]+)\/download$/.exec(path);
      if (download) {
        const stored = artifacts.get(download[1]!);
        if (!stored?.bytes || stored.state !== "ready") return new Response(null, { status: 404 });
        calls.downloads.push(stored.id);
        return new Response(stored.bytes as Uint8Array<ArrayBuffer>, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      const read = /^\/artifacts\/([^/]+)$/.exec(path);
      if (read && request.method === "GET") {
        const stored = artifacts.get(read[1]!);
        if (!stored) return new Response(null, { status: 404 });
        return Response.json({
          id: stored.id,
          filename: stored.filename,
          declaredContentType: stored.contentType,
          declaredBytes: stored.byteSize,
          declaredSha256: stored.sha256,
          state: stored.state,
          copyState: stored.copyState,
          verifiedBytes: stored.state === "ready" ? stored.byteSize : null,
          verifiedSha256: stored.state === "ready" ? stored.sha256 : null,
          failureCode: null,
        });
      }
      if (path === "/artifacts" && request.method === "POST") {
        if (failReserve) {
          failReserve = false;
          return new Response(null, { status: 500 });
        }
        calls.reserves++;
        const reservationKey = String(body.idempotencyKey);
        let id = reservations.get(reservationKey);
        if (!id) {
          id = randomUUID();
          reservations.set(reservationKey, id);
          artifacts.set(id, {
            id,
            filename: String(body.filename),
            contentType: String(body.contentType),
            byteSize: Number(body.byteSize),
            sha256: String(body.sha256),
            state: "reserved",
            copyState: "none",
          });
        }
        const stored = artifacts.get(id)!;
        return Response.json(
          {
            id,
            filename: stored.filename,
            declaredContentType: stored.contentType,
            declaredBytes: stored.byteSize,
            declaredSha256: stored.sha256,
            state: stored.state,
            copyState: stored.copyState,
            verifiedBytes: stored.state === "ready" ? stored.byteSize : null,
            verifiedSha256: stored.state === "ready" ? stored.sha256 : null,
            failureCode: null,
          },
          { status: 201 },
        );
      }
      const action = /^\/artifacts\/([^/]+)\/(upload|complete)$/.exec(path);
      if (action) {
        const stored = artifacts.get(action[1]!);
        if (!stored) return new Response(null, { status: 404 });
        if (action[2] === "upload") {
          stored.copyState = "started";
          return Response.json({
            uploadUrl: `${url.origin}/blob/${stored.id}`,
            method: "PUT",
            headers: { "content-type": stored.contentType, "x-vercel-blob-access": "private" },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        if (!stored.bytes) return new Response(null, { status: 409 });
        if (stored.bytes.byteLength !== stored.byteSize || sha256(stored.bytes) !== stored.sha256)
          return Response.json({ error: "mismatch" }, { status: 409 });
        stored.state = "ready";
        stored.copyState = "acknowledged";
        return Response.json({
          id: stored.id,
          filename: stored.filename,
          declaredContentType: stored.contentType,
          declaredBytes: stored.byteSize,
          declaredSha256: stored.sha256,
          state: "ready",
          copyState: "acknowledged",
          verifiedBytes: stored.byteSize,
          verifiedSha256: stored.sha256,
          failureCode: null,
        });
      }
      if (path === `/dataset-versions/${datasetVersionId}`)
        return Response.json({
          id: datasetVersionId,
          datasetId: randomUUID(),
          version: 1,
          revision: 1,
          frozenAt: new Date().toISOString(),
          contentDigest: digest,
        });
      if (path === `/experiments/${experiment.id}`) return Response.json(experiment);
      if (path === `/experiments/${experiment.id}/items`)
        return Response.json({
          items: [
            {
              id: item.id,
              externalKey: item.externalKey,
              hasExpected: item.hasExpected,
              execution: null,
            },
          ],
          nextCursor: null,
        });
      if (path === `/experiments/${experiment.id}/items/${item.id}`) return Response.json(item);
      if (path === `/experiments/${experiment.id}/items/${item.id}/start`) {
        const execution: Execution = {
          id: randomUUID(),
          state: "started",
          attempt: 1,
          traceExternalId: String(body.traceExternalId),
        };
        executions.set(execution.id, execution);
        return Response.json(execution);
      }
      if (path === `/experiments/${experiment.id}/finish`)
        return Response.json({ id: experiment.id, finishedAt: new Date().toISOString() });
      const executionMatch = /^\/experiment-executions\/([^/]+)(\/complete)?$/.exec(path);
      if (executionMatch) {
        const execution = executions.get(executionMatch[1]!);
        if (!execution) return new Response(null, { status: 404 });
        if (!executionMatch[2]) return Response.json(execution);
        const ids = (body.artifactIds as string[] | undefined) ?? [];
        if (ids.some((id) => artifacts.get(id)?.state !== "ready"))
          return new Response(null, { status: 409 });
        execution.state = body.state as Execution["state"];
        calls.completions.push(body);
        const subjectId = randomUUID();
        const hasOutput = Object.hasOwn(body, "output");
        // Freeze the manifest the way the server does: case inputs plus the target's outputs.
        const files: SubjectFile[] = [
          ...(item.inputFiles ?? []),
          ...ids.map((id) => {
            const stored = artifacts.get(id)!;
            return {
              artifactId: id,
              role: "output" as const,
              filename: stored.filename,
              contentType: stored.contentType,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
            };
          }),
        ];
        subjects.set(subjectId, {
          id: subjectId,
          executionId: execution.id,
          inputs: item.inputs,
          hasOutput,
          ...(hasOutput ? { output: body.output as JsonValue } : {}),
          hasExpected: false,
          metadata: item.metadata,
          contentDigest: digest,
          outputEvidence: hasOutput ? "available" : "unavailable",
          executionState: execution.state as "succeeded" | "error" | "cancelled",
          traceSnapshotId: null,
          caseId: item.id,
          datasetVersionId,
          caseExternalKey: item.externalKey,
          experimentId: experiment.id,
          attempt: 1,
          traceEvidence: "omitted",
          traceExternalId: execution.traceExternalId,
          omissionReason: null,
          environmentVersionId: item.environmentVersionId ?? null,
          files,
          primaryArtifactId: (body.primaryArtifactId as string | undefined) ?? null,
        });
        return Response.json({
          executionId: execution.id,
          subjectId,
          evaluationItemId: randomUUID(),
          traceSnapshotId: body.traceEvidence === "omit" ? null : randomUUID(),
        } satisfies Completion);
      }
      if (path.startsWith("/experiment-executions/") && path.endsWith("/environment")) {
        calls.environmentReads++;
        return new Response(null, { status: environmentStatus });
      }
      if (path === "/evaluation-runs" && request.method === "POST") {
        const id = randomUUID();
        const scorerVersionIds = body.scorerVersionIds as string[];
        scoringRuns.set(id, {
          scorerVersions: options.scorers.filter((version) =>
            scorerVersionIds.includes(version.id),
          ),
          items: (body.subjectIds as string[]).map((subjectId) => ({
            id: randomUUID(),
            subjectId,
            hasOutput: subjects.get(subjectId)?.hasOutput ?? false,
            traceSnapshotId: null,
          })),
        });
        return Response.json({ id });
      }
      const scoringMatch = /^\/evaluation-runs\/([^/]+)(?:\/(items|results))?$/.exec(path);
      if (scoringMatch) {
        const run = scoringRuns.get(scoringMatch[1]!);
        if (scoringMatch[2] === "results" || scoringMatch[1] === experiment.evaluation.id) {
          const results = storedResults.get(scoringMatch[1]!) ?? [];
          if (request.method === "GET") {
            // One result per page exercises receipt lookup beyond the first page.
            const after = url.searchParams.get("after");
            const offset = after ? results.findIndex((result) => result.id === after) + 1 : 0;
            const items = results.slice(offset, offset + 1);
            return Response.json({
              items,
              nextCursor: offset + 1 < results.length ? items[0]!.id : null,
            });
          }
          const submitted = body.results as Result[];
          const conflict = conflictOnce;
          conflictOnce = undefined;
          if (conflict === "unrelated") return new Response(null, { status: 409 });
          if (
            submitted.some((score) =>
              results.some(
                (result) =>
                  result.itemId === score.evaluationItemId &&
                  result.scorerVersionId === score.scorerVersionId,
              ),
            )
          )
            return new Response(null, { status: 409 });
          const saved = submitted.map((score) => ({
            id: randomUUID(),
            itemId: score.evaluationItemId,
            scorerVersionId: score.scorerVersionId,
            state: score.state,
          }));
          storedResults.set(scoringMatch[1]!, [...results, ...saved]);
          if (conflict === "winner") return new Response(null, { status: 409 });
          calls.results.push(...submitted);
          return Response.json({ ids: saved.map((result) => result.id) });
        }
        if (!run) return new Response(null, { status: 404 });
        if (scoringMatch[2] === "items")
          return Response.json({ items: run.items, nextCursor: null });
        return Response.json({
          id: scoringMatch[1],
          name: "grade again",
          scorerVersions: run.scorerVersions,
          itemCount: run.items.length,
          scores: { scored: 0, error: 0, skipped: 0, pending: run.items.length },
        });
      }
      const subjectMatch = /^\/evaluation-subjects\/([^/]+)$/.exec(path);
      if (subjectMatch) {
        const subject = subjects.get(subjectMatch[1]!);
        return subject ? Response.json(subject) : new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request ${request.method} ${path}`);
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    server,
    baseUrl,
    calls,
    artifacts,
    item,
    inputs,
    experiment,
    conflictNextResult: (kind: "winner" | "unrelated") => {
      conflictOnce = kind;
    },
    /** Status the environment evidence endpoint answers with; 404 means "no linked world". */
    setEnvironmentStatus: (status: number) => {
      environmentStatus = status;
    },
  };
}

describe("file-based cases", () => {
  test("filename truncation keeps 200 UTF-8 bytes and never splits a code point", () => {
    // A name that fits, 200 bytes exactly, is unchanged.
    const fits = `${"a".repeat(196)}😀`;
    expect(Buffer.byteLength(fits)).toBe(200);
    expect(safeFilename(fits)).toBe(fits);
    // A longer one is shortened to leave room for the hash mark; the emoji that no longer fits
    // is dropped whole, not cut.
    const shortened = safeFilename(`${"a".repeat(188)}😀😀ignored`);
    expect(shortened).toMatch(/^a{188}~[0-9a-f]{8}$/u);
    // A longer name keeps its extension, and its shortened stem is marked by a hash of the
    // whole name, so two long names stay distinct.
    const long = safeFilename(`${"é".repeat(99)}.pdf`);
    expect(long).toMatch(/^é+~[0-9a-f]{8}\.pdf$/u);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(safeFilename(`${"é".repeat(99)}.pdf`)).toBe(long);
    const first = safeFilename(`${"x".repeat(197)}.pdf`);
    const second = safeFilename(`${"x".repeat(198)}.pdf`);
    expect(first).not.toBe(second);
    for (const name of [first, second]) {
      expect(name.endsWith(".pdf")).toBe(true);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    }
    // A name that fits is unchanged.
    expect(safeFilename(`${"x".repeat(196)}.pdf`)).toBe(`${"x".repeat(196)}.pdf`);
  });

  test("downloads pinned inputs, uploads generated files and grades them locally", async () => {
    const seen: { scorer?: LocalFile[]; target?: LocalFile[] } = {};
    const grader = defineLocalScorer({
      source: "document grader",
      entrypoint: "grade",
      metrics: [{ name: "letter_bytes", type: "number", min: 0 }],
      async score(context) {
        seen.scorer = context.files;
        const letter = context.files!.find((file) => file.role === "output" && file.primary)!;
        const bytes = await readFile(letter.path);
        expect(sha256(bytes)).toBe(letter.sha256);
        expect(context.hasOutput).toBe(true);
        return {
          state: "scored",
          metrics: [{ name: "letter_bytes", value: bytes.byteLength, passed: true }],
          explanation: `Graded ${letter.filename}`,
        };
      },
    });
    const f = fixture({ scorers: [version(grader.definition), version(builtins.exactMatch())] });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "documents",
      captureContent: false,
    });
    const checkpointDirectory = await directory();
    try {
      const report = await runExperiment({
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        experimentId: f.experiment.id,
        checkpointDirectory,
        persistResultContent: true,
        environmentEvidence: "when_pinned",
        traceEvidence: { mode: "required" },
        scorers: [grader],
        async target(inputs, context) {
          expect(inputs).toEqual(f.item.inputs);
          seen.target = context.files;
          // The agent sees the report and the template, never the evaluator-only file.
          expect(context.files.map((file) => file.role).sort()).toEqual([
            "attached_template",
            "source",
          ]);
          for (const file of context.files) {
            expect((await stat(file.path)).mode & 0o077).toBe(0);
            expect(sha256(await readFile(file.path))).toBe(file.sha256);
          }
          const letter = join(context.outputDirectory, "Letter.docx");
          await writeFile(letter, "generated letter");
          return withFiles({ summary: "2 imágenes insertadas" }, [
            { path: letter, filename: "Résumé final.docx", contentType: docx, primary: true },
            {
              bytes: Buffer.from("questionnaire"),
              filename: "Cuestionario.docx",
              contentType: docx,
            },
          ]);
        },
      });
      expect(report.subjectIds).toHaveLength(1);
      expect(f.calls.environmentReads).toBe(0);
      // Every pinned input was downloaded; the evaluator-only template twice: checked before the
      // execution started, then saved for the grader after the target finished.
      expect([...f.calls.downloads].sort()).toEqual(
        [
          f.inputs.source.id,
          f.inputs.template.id,
          f.inputs.evaluatorOnly.id,
          f.inputs.evaluatorOnly.id,
        ].sort(),
      );
      expect(f.calls.reserves).toBe(2);
      expect(f.calls.uploads).toBe(2);
      const completion = f.calls.completions[0]!;
      expect(completion.state).toBe("succeeded");
      expect(completion.output).toEqual({ summary: "2 imágenes insertadas" });
      const artifactIds = completion.artifactIds as string[];
      expect(artifactIds).toHaveLength(2);
      const primary = f.artifacts.get(String(completion.primaryArtifactId))!;
      expect(primary.filename).toBe("Résumé final.docx");
      expect(primary.state).toBe("ready");
      expect(Buffer.from(primary.bytes!).toString()).toBe("generated letter");
      // The grader saw every input plus both generated files with verified identities.
      expect(seen.scorer!.map((file) => file.role).sort()).toEqual([
        "attached_template",
        "org_template",
        "output",
        "output",
        "source",
      ]);
      expect(
        seen
          .scorer!.filter((file) => file.role === "output")
          .map((file) => file.artifactId)
          .sort(),
      ).toEqual([...artifactIds].sort());
      expect(f.calls.results).toHaveLength(2);
      expect(f.calls.results.find((result) => result.state === "scored")).toMatchObject({
        metrics: [{ name: "letter_bytes", value: "generated letter".length }],
        sourceDigest: grader.definition.sourceDigest,
      });
      // Exact match has a JSON output but no reference; it is skipped, never a zero.
      expect(f.calls.results.find((result) => result.state === "skipped")).toMatchObject({
        explanation: "Reference evidence is unavailable",
      });
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  test("grading again fetches the frozen inputs and outputs and scores a case without a world", async () => {
    const seen: LocalFile[][] = [];
    const grader = defineLocalScorer({
      source: "regrade saved documents",
      entrypoint: "grade",
      metrics: [{ name: "letter_present", type: "boolean" }],
      async score(context) {
        seen.push(context.files ?? []);
        const letter = context.files?.find((file) => file.role === "output" && file.primary);
        if (letter) expect(sha256(await readFile(letter.path))).toBe(letter.sha256);
        return {
          state: "scored",
          metrics: [{ name: "letter_present", value: Boolean(letter), passed: Boolean(letter) }],
          explanation: letter ? `Graded ${letter.filename}` : "No letter",
        };
      },
    });
    const version = { id: randomUUID(), contentDigest: digest, definition: grader.definition };
    const f = fixture({ scorers: [version] });
    const client = createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "regrade",
      captureContent: false,
    });
    try {
      const report = await runExperiment({
        client,
        hue,
        experimentId: f.experiment.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
        traceEvidence: { mode: "omit", reason: "Synthetic worker keeps traces local" },
        scorers: [grader],
        target: () =>
          withFiles({ summary: "listo" }, [
            {
              bytes: Buffer.from("saved letter"),
              filename: "Letter.docx",
              contentType: docx,
              primary: true,
            },
          ]),
      });
      const scoring = await client.createEvaluationRun({
        idempotencyKey: randomUUID(),
        name: "Grade again",
        subjectIds: report.subjectIds,
        scorerVersionIds: [version.id],
      });
      const resultsBefore = f.calls.results.length;
      const downloadsBefore = f.calls.downloads.length;
      const checkpointDirectory = await directory();
      const regraded = await rescore({
        client,
        runId: scoring.id,
        checkpointDirectory,
        persistResultContent: true,
        // A case without a world must not be reported as missing environment evidence.
        environmentEvidence: "when_pinned",
        scorers: [grader],
      });
      expect(regraded.resultIds).toHaveLength(1);
      expect(f.calls.environmentReads).toBe(0);
      const files = seen.at(-1)!;
      expect(files.map((file) => [file.role, file.primary ?? false]).sort()).toEqual([
        ["attached_template", false],
        ["org_template", false],
        ["output", true],
        ["source", false],
      ]);
      // The letter was downloaded by identity, not reused from the first run's staging copy.
      expect(f.calls.downloads.length - downloadsBefore).toBe(4);
      expect(f.calls.results.slice(resultsBefore)).toMatchObject([
        {
          state: "scored",
          metrics: [{ name: "letter_present", value: true }],
          sourceDigest: grader.definition.sourceDigest,
        },
      ]);
      // Resuming reuses the verified copies and never re-downloads or re-scores.
      const again = await rescore({
        client,
        runId: scoring.id,
        checkpointDirectory,
        persistResultContent: true,
        environmentEvidence: "when_pinned",
        scorers: [grader],
      });
      expect(again.resultIds).toEqual(regraded.resultIds);
      expect(f.calls.downloads.length - downloadsBefore).toBe(4);
      expect(f.calls.results.length - resultsBefore).toBe(1);
      expect(seen).toHaveLength(2); // Original execution plus the single regrade.
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  for (const timing of ["completed", "winner", "unrelated"] as const) {
    test(`regrading preserves hosted results and only resolves matching conflicts (${timing})`, async () => {
      let invocations = 0;
      const grader = defineLocalScorer({
        source: "letter grader with a hosted builtin",
        entrypoint: "grade",
        metrics: [{ name: "letter_present", type: "boolean" }],
        score(context) {
          invocations++;
          expect(context.files?.some((file) => file.role === "output")).toBe(true);
          return {
            state: "scored",
            metrics: [{ name: "letter_present", value: true }],
            explanation: "Verified the saved letter",
          };
        },
      });
      const builtin = version(builtins.exactMatch());
      const local = version(grader.definition);
      const f = fixture({ scorers: [builtin, local] });
      const client = createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl });
      const hue = createHue({
        apiKey: key,
        baseUrl: f.baseUrl,
        serviceName: "mixed-regrade",
        captureContent: false,
      });
      try {
        const original = await runExperiment({
          client,
          hue,
          experimentId: f.experiment.id,
          checkpointDirectory: await directory(),
          persistResultContent: true,
          traceEvidence: { mode: "omit", reason: "Synthetic test" },
          scorers: [grader],
          target: () =>
            withFiles({ summary: "done" }, [
              { bytes: Buffer.from("saved letter"), filename: "Letter.docx", contentType: docx },
            ]),
        });
        const run = await client.createEvaluationRun({
          idempotencyKey: randomUUID(),
          name: "Hosted and local grading",
          subjectIds: original.subjectIds,
          scorerVersionIds: [builtin.id, local.id],
        });
        let hostedId: string | undefined;
        if (timing === "completed") {
          const items = await client.listEvaluationItems(run.id);
          const result = await client.submitResults(run.id, {
            idempotencyKey: randomUUID(),
            results: [
              {
                evaluationItemId: items.items[0]!.id,
                scorerVersionId: builtin.id,
                state: "skipped",
                explanation: "Hosted check has no expected value",
              },
            ],
          });
          hostedId = result.ids[0];
        } else f.conflictNextResult(timing);
        const before = f.calls.results.length;
        const options = {
          client,
          runId: run.id,
          checkpointDirectory: await directory(),
          persistResultContent: true,
          scorers: [grader],
        };
        if (timing === "unrelated") {
          await expect(rescore(options)).rejects.toThrow("HTTP 409");
          expect(f.calls.results).toHaveLength(before);
        }
        const report = await rescore(options);
        expect(report.resultIds).toHaveLength(2);
        if (hostedId) expect(report.resultIds).toContain(hostedId);
        expect(invocations).toBe(2); // Original execution and exactly one local regrade.
        const submitted = f.calls.results.slice(before);
        expect(submitted.filter((result) => result.scorerVersionId === local.id)).toHaveLength(1);
        expect(submitted.find((result) => result.scorerVersionId === local.id)?.state).toBe(
          "scored",
        );
        expect(submitted.filter((result) => result.scorerVersionId === builtin.id)).toHaveLength(
          timing === "unrelated" ? 1 : 0,
        );
        const downloads = f.calls.downloads.length;
        // A new checkpoint still preserves both terminal results, including paginated receipts.
        const again = await rescore({ ...options, checkpointDirectory: await directory() });
        expect(again.resultIds.sort()).toEqual(report.resultIds.sort());
        expect(invocations).toBe(2);
        expect(f.calls.downloads).toHaveLength(downloads);
        expect(f.calls.results).toHaveLength(before + submitted.length);
      } finally {
        await hue.shutdown();
        f.server.stop(true);
      }
    });
  }

  test("a builtin-only regrade grades the stored output without downloading any files", async () => {
    const builtin = version(builtins.exactMatch());
    const f = fixture({ scorers: [builtin] });
    const client = createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "builtin-regrade",
      captureContent: false,
    });
    try {
      const original = await runExperiment({
        client,
        hue,
        experimentId: f.experiment.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
        traceEvidence: { mode: "omit", reason: "Synthetic test" },
        target: () =>
          withFiles({ ok: true }, [
            { bytes: Buffer.from("saved letter"), filename: "Letter.docx", contentType: docx },
          ]),
      });
      const run = await client.createEvaluationRun({
        idempotencyKey: randomUUID(),
        name: "Builtin regrade",
        subjectIds: original.subjectIds,
        scorerVersionIds: [builtin.id],
      });
      const downloads = f.calls.downloads.length;
      const report = await rescore({
        client,
        runId: run.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
        deferUnboundLocalScorers: true,
      });
      expect(report.resultIds).toHaveLength(1);
      // The built-in grades the stored JSON; the subject's files (a scorer-only organization
      // template among them) stay off this machine.
      expect(f.calls.downloads).toHaveLength(downloads);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  test("an empty declared file list is a JSON-only outcome, not a target error", async () => {
    const f = fixture({ scorers: [version(builtins.exactMatch())] });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "no-files",
      captureContent: false,
    });
    try {
      const report = await runExperiment({
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        experimentId: f.experiment.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
        traceEvidence: { mode: "required" },
        target: () => withFiles({ answer: 42 }, []),
      });
      expect(report.subjectIds).toHaveLength(1);
      expect(f.calls.reserves).toBe(0);
      expect(f.calls.completions[0]).toMatchObject({ state: "succeeded", output: { answer: 42 } });
      expect(f.calls.completions[0]).not.toHaveProperty("artifactIds");
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  test("a code evaluator grades generated files without a JSON output; built-ins stay skipped", async () => {
    const grader = defineLocalScorer({
      source: "files only",
      entrypoint: "grade",
      metrics: [{ name: "has_letter", type: "boolean" }],
      score(context) {
        expect(context.hasOutput).toBe(false);
        const outputs = context.files!.filter((file) => file.role === "output");
        return {
          state: "scored",
          metrics: [{ name: "has_letter", value: outputs.length === 1, passed: true }],
          explanation: "Generated file present",
        };
      },
    });
    const f = fixture({ scorers: [version(grader.definition), version(builtins.exactMatch())] });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "files-only",
      captureContent: false,
    });
    try {
      await runExperiment({
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        experimentId: f.experiment.id,
        checkpointDirectory: await directory(),
        persistResultContent: false,
        traceEvidence: { mode: "required" },
        scorers: [grader],
        target: () =>
          withFiles(undefined, [
            { bytes: Buffer.from("letter"), filename: "Letter.docx", contentType: docx },
          ]),
      });
      expect(f.calls.completions[0]).not.toHaveProperty("output");
      expect((f.calls.completions[0]!.artifactIds as string[]).length).toBe(1);
      expect(f.calls.completions[0]).not.toHaveProperty("primaryArtifactId");
      expect(f.calls.results.map((result) => result.state).sort()).toEqual(["scored", "skipped"]);
      expect(f.calls.results.find((result) => result.state === "skipped")).toMatchObject({
        explanation: "Output evidence is unavailable",
      });
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  test("files the target declares but cannot deliver are its own error, not an uncertain run", async () => {
    const f = fixture({ scorers: [version(builtins.exactMatch())] });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "missing-file",
      captureContent: false,
    });
    try {
      await runExperiment({
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        experimentId: f.experiment.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
        traceEvidence: { mode: "required" },
        target: (_inputs, context) =>
          withFiles({ note: "claimed a file" }, [
            {
              path: join(context.outputDirectory, "missing.docx"),
              filename: "missing.docx",
              contentType: docx,
            },
          ]),
      });
      expect(f.calls.completions[0]).toMatchObject({
        state: "error",
        output: { note: "claimed a file" },
        error: { type: "TargetError", message: "Generated file missing.docx could not be read" },
      });
      expect(f.calls.completions[0]).not.toHaveProperty("artifactIds");
      expect(f.calls.reserves).toBe(0);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  test("a started copy without stored bytes resumes by issuing another PUT", async () => {
    const f = fixture({ scorers: [version(builtins.exactMatch())], failPutOnce: true });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "resume-started-copy",
      captureContent: false,
    });
    const checkpointDirectory = await directory();
    let invocations = 0;
    const options = {
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      experimentId: f.experiment.id,
      checkpointDirectory,
      persistResultContent: true,
      traceEvidence: { mode: "omit" as const, reason: "Synthetic worker keeps traces local" },
      target: () => {
        invocations++;
        return withFiles({ ok: true }, [
          { bytes: Buffer.from("letter"), filename: "Letter.docx", contentType: docx },
        ]);
      },
    };
    try {
      // Completion finds no bytes; reading the artifact shows it was never verified.
      await expect(runExperiment(options)).rejects.toThrow(
        "Generated file Letter.docx was not verified by Hue (reserved)",
      );
      expect(invocations).toBe(1);
      expect(f.calls.uploads).toBe(0);
      expect(f.calls.completions).toHaveLength(0);
      const report = await runExperiment(options);
      expect(invocations).toBe(1);
      expect(f.calls.uploads).toBe(1);
      expect(report.subjectIds).toHaveLength(1);
      expect(f.calls.completions[0]).toMatchObject({ state: "succeeded", output: { ok: true } });
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  test("a failed upload resumes from the staged files without invoking the target again", async () => {
    const f = fixture({ scorers: [version(builtins.exactMatch())], failReserveOnce: true });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "resume",
      captureContent: false,
    });
    const checkpointDirectory = await directory();
    let invocations = 0;
    const options = {
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      experimentId: f.experiment.id,
      checkpointDirectory,
      persistResultContent: true,
      traceEvidence: { mode: "omit" as const, reason: "Synthetic worker keeps traces local" },
      target: () => {
        invocations++;
        return withFiles({ ok: true }, [
          { bytes: Buffer.from("letter"), filename: "Letter.docx", contentType: docx },
        ]);
      },
    };
    try {
      await expect(runExperiment(options)).rejects.toThrow("HTTP 500");
      expect(invocations).toBe(1);
      expect(f.calls.completions).toHaveLength(0);
      const report = await runExperiment(options);
      expect(invocations).toBe(1);
      expect(report.subjectIds).toHaveLength(1);
      expect(f.calls.completions[0]).toMatchObject({ state: "succeeded", output: { ok: true } });
      expect((f.calls.completions[0]!.artifactIds as string[]).length).toBe(1);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  test("runLocalAgent hands ordinary cases to directTarget and registers direct:v1", async () => {
    const grader = defineLocalScorer({
      source: "grade direct files without a world service",
      entrypoint: "score",
      metrics: [{ name: "letter_present", type: "boolean" }],
      score(context) {
        expect(context.environment).toBeUndefined();
        expect(context.files?.some((file) => file.role === "output")).toBe(true);
        return {
          state: "scored",
          metrics: [{ name: "letter_present", value: true }],
          explanation: "Graded the saved document without environment evidence",
        };
      },
    });
    const f = fixture({ scorers: [version(grader.definition)] });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "direct-worker",
      captureContent: false,
    });
    let context: Record<string, unknown> | undefined;
    try {
      await runLocalAgent({
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
        environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        checkpointDirectory: await directory(),
        agent: {
          key: "letter-worker",
          name: "Letter worker",
          revision: "test",
          capabilities: ["input:docx", "output:docx"],
        },
        maxRuns: 1,
        scorers: [grader],
        pollIntervalMillis: 250,
        directTarget(inputs, direct) {
          context = { ...direct, inputs };
          return withFiles({ summary: "done" }, [
            { bytes: Buffer.from("letter"), filename: "Letter.docx", contentType: docx },
          ]);
        },
      });
      expect(f.calls.registrations[0]!.capabilities).toEqual([
        "input:docx",
        "output:docx",
        "direct:v1",
      ]);
      expect(f.calls.environmentReads).toBe(0);
      expect(f.calls.results).toMatchObject([
        { state: "scored", metrics: [{ name: "letter_present", value: true }] },
      ]);
      expect(context).toMatchObject({
        inputs: f.item.inputs,
        item: { id: f.item.id, externalKey: "letter-1" },
        config: { variant: "baseline" },
      });
      expect(Object.keys(context!).sort()).toEqual([
        "config",
        "executionId",
        "files",
        "inputs",
        "item",
        "outputDirectory",
        "trace",
      ]);
      expect((context!.files as LocalFile[]).map((file) => file.role).sort()).toEqual([
        "attached_template",
        "source",
      ]);
      expect(f.calls.completions[0]).toMatchObject({
        state: "succeeded",
        output: { summary: "done" },
      });
      expect(f.calls.localRun).toEqual([{ state: "completed" }]);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  test("a pinned world still blocks local grading when its evidence service is unavailable", async () => {
    let scored = 0;
    const grader = defineLocalScorer({
      source: "require pinned world evidence",
      entrypoint: "score",
      metrics: [],
      score() {
        scored++;
        return { state: "scored", metrics: [], explanation: "World checked" };
      },
    });
    const f = fixture({ scorers: [version(grader.definition)] });
    f.item.environmentVersionId = randomUUID();
    const client = createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "world-evidence",
      captureContent: false,
    });
    try {
      const report = await runExperiment({
        client,
        hue,
        experimentId: f.experiment.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
        environmentEvidence: "when_pinned",
        traceEvidence: { mode: "omit", reason: "Synthetic evidence failure" },
        scorers: [grader],
        target: () => ({ summary: "done" }),
      });
      const historical = await client.createEvaluationRun({
        idempotencyKey: randomUUID(),
        name: "Retry world grade",
        subjectIds: report.subjectIds,
        scorerVersionIds: [f.experiment.evaluation.scorerVersions[0]!.id],
      });
      await rescore({
        client,
        runId: historical.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
        environmentEvidence: "when_pinned",
        scorers: [grader],
      });
      expect(f.calls.environmentReads).toBeGreaterThanOrEqual(2);
      expect(scored).toBe(0);
      expect(f.calls.results).toMatchObject([
        { state: "error", error: { type: "EnvironmentEvidenceUnavailable" } },
        { state: "error", error: { type: "EnvironmentEvidenceUnavailable" } },
      ]);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });

  test("required evidence tolerates a missing world only for a case that pins none", async () => {
    // Generic targets may attach a world independently of the case pin, so "required" still
    // reads the evidence endpoint; a 404 for an unpinned case is benign, any other failure is not.
    for (const [status, expected] of [
      [404, { state: "scored" }],
      [503, { state: "error", error: { type: "EnvironmentEvidenceUnavailable" } }],
    ] as const) {
      let scored = 0;
      const grader = defineLocalScorer({
        source: `required evidence ${status}`,
        entrypoint: "score",
        metrics: [],
        score(context) {
          scored++;
          expect(context.environment).toBeUndefined();
          return { state: "scored", metrics: [], explanation: "Graded without a world" };
        },
      });
      const f = fixture({ scorers: [version(grader.definition)] });
      f.setEnvironmentStatus(status);
      expect(f.item.environmentVersionId).toBeNull();
      const client = createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl });
      const hue = createHue({
        apiKey: key,
        baseUrl: f.baseUrl,
        serviceName: "required-evidence",
        captureContent: false,
      });
      try {
        await runExperiment({
          client,
          hue,
          experimentId: f.experiment.id,
          checkpointDirectory: await directory(),
          persistResultContent: true,
          environmentEvidence: "required",
          traceEvidence: { mode: "omit", reason: "Synthetic evidence check" },
          scorers: [grader],
          target: () => ({ summary: "done" }),
        });
        expect(f.calls.environmentReads).toBeGreaterThanOrEqual(1);
        expect(scored).toBe(status === 404 ? 1 : 0);
        expect(f.calls.results).toHaveLength(1);
        expect(f.calls.results[0]).toMatchObject(expected);
      } finally {
        await hue.shutdown();
        f.server.stop(true);
      }
    }
  });

  test("upload capabilities are refused when they carry credentials, fragments or invalid grants", async () => {
    const f = fixture({ scorers: [] });
    const client = createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl });
    const bytes = Buffer.from("letter");
    const valid = { method: "PUT" as const, headers: { "content-type": docx }, expiresAt: "" };
    try {
      for (const uploadUrl of [
        `${f.baseUrl.replace("http://", "http://user:secret@")}/blob/x`,
        `${f.baseUrl}/blob/x#fragment`,
        "http://169.254.169.254/blob/x",
      ])
        await expect(
          client.uploadArtifactBytes({ ...valid, uploadUrl }, bytes, docx),
        ).rejects.toBeInstanceOf(HueApiError);
      for (const headers of ["content-type: x", { cookie: "session" }])
        await expect(
          client.uploadArtifactBytes(
            { ...valid, uploadUrl: `${f.baseUrl}/blob/x`, headers: headers as never },
            bytes,
            docx,
          ),
        ).rejects.toBeInstanceOf(HueApiError);
      await expect(
        client.uploadArtifactBytes(
          { ...valid, uploadUrl: `${f.baseUrl}/blob/x`, method: "POST" as never },
          bytes,
          docx,
        ),
      ).rejects.toBeInstanceOf(HueApiError);
    } finally {
      f.server.stop(true);
    }
  });

  test("registrations declare exactly the callbacks they can serve", () => {
    const agent = { key: "a", name: "A", revision: "1" };
    expect(() => registeredCapabilities({ agent })).toThrow("Supply target");
    expect(registeredCapabilities({ agent, target: () => undefined })).toEqual(["environment:v1"]);
    expect(registeredCapabilities({ agent, directTarget: () => undefined })).toEqual(["direct:v1"]);
    expect(
      registeredCapabilities({
        agent: { ...agent, capabilities: ["direct:v1", "input:pdf"] },
        directTarget: () => undefined,
      }),
    ).toEqual(["direct:v1", "input:pdf"]);
    expect(() =>
      registeredCapabilities({
        agent: { ...agent, capabilities: ["direct:v1"] },
        target: () => undefined,
      }),
    ).toThrow("direct:v1 requires a directTarget callback");
    expect(() =>
      registeredCapabilities({
        agent: { ...agent, capabilities: ["environment:v1"] },
        directTarget: () => undefined,
      }),
    ).toThrow("environment:v1 requires a target callback");
  });
});

describe("signed artifact uploads", () => {
  const contentType = "text/plain";
  const bytes = new Uint8Array([1, 2, 3]);
  const capability = (
    uploadUrl: string,
    headers?: ArtifactUpload["headers"],
    method: ArtifactUpload["method"] = "PUT",
  ): ArtifactUpload => ({
    uploadUrl,
    method,
    headers,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  test("omitted or null headers send only the file content-type and preserve the signed URL", async () => {
    const seen: { url: string; contentType: string | null; extra: string[] }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const extra: string[] = [];
        request.headers.forEach((_, name) => {
          if (name !== "content-type" && name !== "content-length") extra.push(name);
        });
        seen.push({
          url: request.url,
          contentType: request.headers.get("content-type"),
          extra,
        });
        return new Response(null, { status: 200 });
      },
    });
    const client = createEvaluationClient({
      apiKey: key,
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    try {
      const signed = `http://127.0.0.1:${server.port}/put?signature=A%2fb+%2B`;
      await client.uploadArtifactBytes(capability(signed, null), bytes, contentType);
      await client.uploadArtifactBytes(capability(signed), bytes, contentType);
      expect(seen).toHaveLength(2);
      expect(seen.every((put) => put.url === signed)).toBe(true);
      expect(seen.every((put) => put.contentType === contentType)).toBe(true);
      expect(seen.every((put) => !put.extra.includes("authorization"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("loopback IPv6 HTTP uploads are accepted", async () => {
    const server = Bun.serve({
      hostname: "::1",
      port: 0,
      fetch() {
        return new Response(null, { status: 200 });
      },
    });
    const client = createEvaluationClient({
      apiKey: key,
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    try {
      await client.uploadArtifactBytes(
        capability(`http://[::1]:${server.port}/put`, {
          "content-type": contentType,
          "x-vercel-blob-access": "private",
        }),
        bytes,
        contentType,
      );
    } finally {
      server.stop(true);
    }
  });

  test("rejects userinfo, fragments, control characters and ungranted headers without sending bytes", async () => {
    let puts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        puts++;
        return new Response(null, { status: 200 });
      },
    });
    const client = createEvaluationClient({
      apiKey: key,
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      for (const uploadUrl of [
        `http://user:pass@127.0.0.1:${server.port}/put`,
        `${origin}/put#fragment`,
        `${origin}/put\nHost: evil.example`,
        "http://example.com/put",
      ]) {
        await expect(
          client.uploadArtifactBytes(
            capability(uploadUrl, { "content-type": contentType }),
            bytes,
            contentType,
          ),
        ).rejects.toBeInstanceOf(HueApiError);
      }
      await expect(
        client.uploadArtifactBytes(
          capability(`${origin}/put`, { authorization: "must-never-forward" }),
          bytes,
          contentType,
        ),
      ).rejects.toBeInstanceOf(HueApiError);
      await expect(
        client.uploadArtifactBytes(
          capability(`${origin}/put`, { cookie: "session=1", "content-type": contentType }),
          bytes,
          contentType,
        ),
      ).rejects.toBeInstanceOf(HueApiError);
      await expect(
        client.uploadArtifactBytes(
          capability(`${origin}/put`, { "x-custom": "nope", "content-type": contentType }),
          bytes,
          contentType,
        ),
      ).rejects.toBeInstanceOf(HueApiError);
      expect(puts).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
