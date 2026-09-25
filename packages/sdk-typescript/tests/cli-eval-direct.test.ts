import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Completion,
  Execution,
  Experiment,
  ScorerVersion,
  StoredResult,
  Subject,
  SubjectFile,
} from "../src/evals.js";
import { collectDirectOutputs, stageDirectCase } from "../src/cli/eval-direct.js";

const cli = join(import.meta.dir, "../src/setup/cli.ts");
const key = "synthetic-eval-key-canary";
const digest = "d".repeat(64);
const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const SPAWN_TIMEOUT = 90_000;

type Stored = {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  state: "reserved" | "ready";
  bytes?: Uint8Array;
};

/**
 * Loopback Hue stand-in for a document eval set: two saved versions, one case with pinned files
 * (one of them evaluator-only), an evaluator with two published code versions, artifacts, and a
 * grader that posts the deferred result a few polls after the letter is uploaded.
 */
function documentStandIn(
  options: {
    gradedAfterPolls?: number;
    verdict?: "pass" | "fail";
    failCompletions?: number;
    /** Refuse trace exports with 400. */
    refuseTraces?: boolean;
    /** Grade as a scorer that never reads the execution state. */
    ignoreExecutionState?: boolean;
    /** Scorer versions (by index) Hue records as not applicable to the case; `forged` answers the
     * same skipped result and evidence without Hue's `notApplicable` flag. */
    notApplicable?: { versions: number[]; forged?: boolean };
  } = {},
) {
  const projectId = randomUUID();
  const dataset = {
    id: randomUUID(),
    name: "GIA D1 citation",
    slug: "gia-d1-citation",
    archivedAt: null,
    versions: [1, 2].map((version) => ({
      id: randomUUID(),
      datasetId: "",
      version,
      revision: version + 1,
      frozenAt: "2026-09-20T00:00:00.000Z",
      contentDigest: digest,
    })),
  };
  for (const version of dataset.versions) version.datasetId = dataset.id;
  const inputs = {
    report: {
      id: randomUUID(),
      name: "Informe.pdf",
      type: "application/pdf",
      bytes: Buffer.from("%PDF-1.4 informe"),
    },
    template: {
      id: randomUUID(),
      name: "Citation_template.docx",
      type: docx,
      bytes: Buffer.from("modelo institucional"),
    },
    corpus: {
      id: randomUUID(),
      name: "legal-corpus.json",
      type: "application/json",
      bytes: Buffer.from('{"schema_version":"1","units":[]}'),
    },
  };
  const artifacts = new Map<string, Stored>();
  for (const input of Object.values(inputs))
    artifacts.set(input.id, {
      id: input.id,
      filename: input.name,
      contentType: input.type,
      byteSize: input.bytes.byteLength,
      sha256: sha256(input.bytes),
      state: "ready",
      bytes: input.bytes,
    });
  const file = (input: (typeof inputs)[keyof typeof inputs], role: string) => ({
    artifactId: input.id,
    role,
    filename: input.name,
    contentType: input.type,
    byteSize: input.bytes.byteLength,
    sha256: sha256(input.bytes),
  });
  const caseOf = (versionId: string) => ({
    id: randomUUID(),
    datasetVersionId: versionId,
    externalKey: "ausentismo-01",
    inputs: { query: "Redacta la citación", tipo_diligencia: "Virtual" },
    hasExpected: false,
    metadata: {
      gia: { expected_images: 2 },
      hue: {
        requiredCapabilities: ["input:docx", "input:pdf", "output:docx"],
        outputFamily: "docx",
      },
    },
    environmentVersionId: null,
    artifactManifestId: randomUUID(),
    inputFiles: [
      file(inputs.template, "attached_template"),
      file(inputs.corpus, "evaluator_reference"),
      file(inputs.report, "source"),
    ],
  });
  const cases = new Map<string, ReturnType<typeof caseOf>>(
    dataset.versions.map((version) => [version.id, caseOf(version.id)]),
  );
  const scorer = {
    id: randomUUID(),
    name: "GIA D1 citation grader",
    slug: "gia-d1-citation",
    archivedAt: null,
  };
  const versionOf = (n: number): ScorerVersion & { version: number } => ({
    id: randomUUID(),
    version: n,
    contentDigest: `${n}`.repeat(64),
    definition: {
      kind: "local_code",
      language: "python",
      entrypoint: "gia_citation.hue:score",
      sourceDigest: `${n}`.repeat(64),
      metrics: [
        { name: "passed", type: "boolean" },
        { name: "errors", type: "number" },
      ],
    },
  });
  const scorerVersions = [versionOf(2), versionOf(1)]; // newest first, as the server orders them
  const experiments = new Map<string, Experiment & { versionId: string }>();
  const executions = new Map<string, Execution & { experimentId: string; caseId: string }>();
  const subjects = new Map<string, Subject>();
  const runItems = new Map<
    string,
    { id: string; subjectId: string; hasOutput: boolean; traceSnapshotId: string | null }[]
  >();
  const results = new Map<string, StoredResult[]>();
  const polls = new Map<string, number>();
  const reservations = new Map<string, string>();
  let failCompletions = options.failCompletions ?? 0;
  const calls = {
    requests: [] as string[],
    experiments: [] as Record<string, unknown>[],
    completions: [] as Record<string, unknown>[],
    downloads: [] as string[],
    uploads: 0,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/blob/")) {
        expect(request.headers.get("authorization")).toBeNull();
        const stored = artifacts.get(url.pathname.slice("/blob/".length))!;
        stored.bytes = new Uint8Array(await request.arrayBuffer());
        calls.uploads++;
        return Response.json({ ok: true });
      }
      const path = url.pathname.replace("/api/v1", "");
      calls.requests.push(`${request.method} ${path}`);
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        return new Response(null, { status: 401 });
      if (path === "/projects/current")
        return Response.json({
          id: projectId,
          name: "August",
          slug: "august",
          organizationId: randomUUID(),
        });
      if (path.startsWith("/otlp/")) {
        await request.arrayBuffer();
        if (options.refuseTraces && path.endsWith("/traces"))
          return new Response(null, { status: 400 });
        return new Response(new Uint8Array(), {
          headers: { "Content-Type": "application/x-protobuf" },
        });
      }
      const body =
        request.method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);
      if (path === "/datasets") {
        const { versions: _versions, ...summary } = dataset;
        return Response.json({ items: [summary], nextCursor: null });
      }
      if (path === `/datasets/${dataset.id}`) return Response.json(dataset);
      const versionMatch = /^\/dataset-versions\/([^/]+)(\/cases)?$/.exec(path);
      if (versionMatch) {
        const version = dataset.versions.find((item) => item.id === versionMatch[1]);
        if (!version) return new Response(null, { status: 404 });
        if (versionMatch[2])
          return Response.json({ items: [cases.get(version.id)], nextCursor: null });
        return Response.json(version);
      }
      if (path === "/scorers")
        return Response.json({
          items: [scorer, { id: randomUUID(), name: "Other", slug: "other", archivedAt: null }],
          nextCursor: null,
        });
      if (path === `/scorers/${scorer.id}`)
        return Response.json({ ...scorer, versions: scorerVersions });
      if (path === "/experiments") {
        calls.experiments.push(body);
        const version = dataset.versions.find((item) => item.id === body.datasetVersionId);
        if (!version) return new Response(null, { status: 404 });
        const experiment = {
          id: randomUUID(),
          name: String(body.name),
          datasetVersionId: version.id,
          versionId: version.id,
          config: (body.config ?? {}) as Experiment["config"],
          configDigest: digest,
          evaluation: {
            id: randomUUID(),
            name: "default",
            scorerVersions: scorerVersions.filter((item) =>
              (body.scorerVersionIds as string[]).includes(item.id),
            ),
            itemCount: 1,
            scores: { scored: 0, error: 0, skipped: 0, pending: 1 },
          },
          caseCount: 1,
          finishedAt: null,
          execution: {
            unstarted: 1,
            started: 0,
            uncertain: 0,
            succeeded: 0,
            error: 0,
            cancelled: 0,
          },
        };
        experiments.set(experiment.id, experiment);
        runItems.set(experiment.evaluation.id, []);
        results.set(experiment.evaluation.id, []);
        return Response.json({ id: experiment.id, evaluationRunId: experiment.evaluation.id });
      }
      const experimentMatch =
        /^\/experiments\/([^/]+)(?:\/items(?:\/([^/]+)(?:\/(start))?)?|\/(finish))?$/.exec(path);
      if (experimentMatch) {
        const experiment = experiments.get(experimentMatch[1]!);
        if (!experiment) return new Response(null, { status: 404 });
        const frozenCase = cases.get(experiment.versionId)!;
        if (experimentMatch[4]) {
          experiment.finishedAt = new Date().toISOString();
          return Response.json({ id: experiment.id, finishedAt: experiment.finishedAt });
        }
        if (experimentMatch[3]) {
          const execution = {
            id: randomUUID(),
            attempt: 1,
            state: "started" as const,
            traceExternalId: String(body.traceExternalId),
            experimentId: experiment.id,
            caseId: frozenCase.id,
          };
          executions.set(execution.id, execution);
          return Response.json(execution);
        }
        if (experimentMatch[2])
          return experimentMatch[2] === frozenCase.id
            ? Response.json(frozenCase)
            : new Response(null, { status: 404 });
        if (path.endsWith("/items"))
          return Response.json({
            items: [
              {
                id: frozenCase.id,
                externalKey: frozenCase.externalKey,
                hasExpected: false,
                execution:
                  [...executions.values()].find(
                    (execution) => execution.experimentId === experiment.id,
                  ) ?? null,
              },
            ],
            nextCursor: null,
          });
        const { versionId: _versionId, ...publicExperiment } = experiment;
        return Response.json(publicExperiment);
      }
      const download = /^\/artifacts\/([^/]+)\/download$/.exec(path);
      if (download) {
        const stored = artifacts.get(download[1]!);
        if (!stored?.bytes || stored.state !== "ready") return new Response(null, { status: 404 });
        calls.downloads.push(stored.filename);
        return new Response(stored.bytes as Uint8Array<ArrayBuffer>, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (path === "/artifacts" && request.method === "POST") {
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
            copyState: stored.state === "ready" ? "acknowledged" : "none",
            verifiedBytes: null,
            verifiedSha256: null,
            failureCode: null,
          },
          { status: 201 },
        );
      }
      const action = /^\/artifacts\/([^/]+)\/(upload|complete)$/.exec(path);
      if (action) {
        const stored = artifacts.get(action[1]!);
        if (!stored) return new Response(null, { status: 404 });
        if (action[2] === "upload")
          return Response.json({
            uploadUrl: `${url.origin}/blob/${stored.id}`,
            method: "PUT",
            headers: { "content-type": stored.contentType, "x-vercel-blob-access": "private" },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        if (
          !stored.bytes ||
          stored.bytes.byteLength !== stored.byteSize ||
          sha256(stored.bytes) !== stored.sha256
        )
          return new Response(null, { status: 409 });
        stored.state = "ready";
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
      const executionMatch = /^\/experiment-executions\/([^/]+)(\/complete|\/environment)?$/.exec(
        path,
      );
      if (executionMatch) {
        const execution = executions.get(executionMatch[1]!);
        if (!execution) return new Response(null, { status: 404 });
        if (executionMatch[2] === "/environment") return new Response(null, { status: 404 });
        if (!executionMatch[2]) return Response.json(execution);
        if (failCompletions > 0) {
          failCompletions--;
          return new Response(null, { status: 500 });
        }
        const experiment = experiments.get(execution.experimentId)!;
        const frozenCase = cases.get(experiment.versionId)!;
        const ids = (body.artifactIds as string[] | undefined) ?? [];
        if (ids.some((id) => artifacts.get(id)?.state !== "ready"))
          return new Response(null, { status: 409 });
        execution.state = body.state as Execution["state"];
        calls.completions.push({
          ...body,
          filenames: ids.map((id) => artifacts.get(id)!.filename),
        });
        const subjectId = randomUUID();
        const evaluationItemId = randomUUID();
        const hasOutput = Object.hasOwn(body, "output");
        const files: SubjectFile[] = [
          ...(frozenCase.inputFiles as SubjectFile[]),
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
          inputs: frozenCase.inputs,
          hasOutput,
          ...(hasOutput ? { output: body.output as Subject["output"] } : {}),
          hasExpected: false,
          metadata: frozenCase.metadata,
          contentDigest: digest,
          outputEvidence: hasOutput ? "available" : "unavailable",
          executionState: body.state as Subject["executionState"],
          traceSnapshotId: randomUUID(),
          caseId: frozenCase.id,
          datasetVersionId: experiment.versionId,
          caseExternalKey: frozenCase.externalKey,
          experimentId: experiment.id,
          attempt: 1,
          traceEvidence: "captured",
          traceExternalId: execution.traceExternalId,
          omissionReason: null,
          environmentVersionId: null,
          files,
          primaryArtifactId: (body.primaryArtifactId as string | undefined) ?? null,
        });
        runItems
          .get(experiment.evaluation.id)!
          .push({ id: evaluationItemId, subjectId, hasOutput, traceSnapshotId: randomUUID() });
        // Hue's grading worker posts the deferred code-evaluator result later; the CLI waits for it.
        const failed =
          options.verdict === "fail" ||
          (!options.ignoreExecutionState && body.state !== "succeeded");
        for (const version of experiment.evaluation.scorerVersions) {
          const index = scorerVersions.findIndex((candidate) => candidate.id === version.id);
          if (options.notApplicable?.versions.includes(index)) {
            results.get(experiment.evaluation.id)!.push({
              id: randomUUID(),
              runId: experiment.evaluation.id,
              itemId: evaluationItemId,
              scorerVersionId: version.id,
              state: "skipped",
              metrics: [],
              explanation: "Not applicable: the case has no outcome criteria",
              evidence: {
                state: "not_applicable",
                entry: "hue.outcome_assertions.v3",
                requires: "outcome_criteria",
              },
              error: null,
              sourceDigest: null,
              ...(options.notApplicable.forged ? {} : { notApplicable: true }),
            });
            continue;
          }
          results.get(experiment.evaluation.id)!.push({
            id: randomUUID(),
            runId: experiment.evaluation.id,
            itemId: evaluationItemId,
            scorerVersionId: version.id,
            state: "scored",
            metrics: [
              { name: "passed", value: !failed },
              { name: "errors", value: failed ? 2 : 0 },
            ],
            explanation: failed ? "2 error(s)" : "0 error(s), gates 8/8",
            evidence: null,
            error: null,
            sourceDigest:
              version.definition.kind === "local_code" ? version.definition.sourceDigest : null,
          });
        }
        return Response.json({
          executionId: execution.id,
          subjectId,
          evaluationItemId,
          traceSnapshotId: randomUUID(),
        } satisfies Completion);
      }
      const runMatch = /^\/evaluation-runs\/([^/]+)\/(items|results)$/.exec(path);
      if (runMatch) {
        if (runMatch[2] === "items")
          return Response.json({ items: runItems.get(runMatch[1]!) ?? [], nextCursor: null });
        const seen = (polls.get(runMatch[1]!) ?? 0) + 1;
        polls.set(runMatch[1]!, seen);
        if (seen <= (options.gradedAfterPolls ?? 0))
          return Response.json({ items: [], nextCursor: null });
        return Response.json({
          items: (results.get(runMatch[1]!) ?? []).map(
            ({ id, itemId, scorerVersionId, state }) => ({ id, itemId, scorerVersionId, state }),
          ),
          nextCursor: null,
        });
      }
      const resultMatch = /^\/evaluation-results\/([^/]+)$/.exec(path);
      if (resultMatch) {
        const stored = [...results.values()].flat().find((item) => item.id === resultMatch[1]);
        return stored ? Response.json(stored) : new Response(null, { status: 404 });
      }
      const subjectMatch = /^\/evaluation-subjects\/([^/]+)$/.exec(path);
      if (subjectMatch) {
        const subject = subjects.get(subjectMatch[1]!);
        return subject ? Response.json(subject) : new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request ${request.method} ${path}`);
    },
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    dataset,
    scorerVersions,
    artifacts,
    stop: () => server.stop(true),
  };
}

function hue(args: string[], options: { cwd: string; env?: Record<string, string> }) {
  const { HUE_API_KEY: _key, HUE_BASE_URL: _origin, ...inherited } = process.env;
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cli, "eval", ...args], {
        cwd: options.cwd,
        env: { ...inherited, NO_COLOR: "1", HUE_API_KEY: key, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), SPAWN_TIMEOUT);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    },
  );
}

/** Stands in for August's adapter: reads the case directory, writes the letters and a summary. */
const agentSource = `import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HUE_CASE_DIR;
const inputs = JSON.parse(readFileSync(process.env.HUE_CASE_INPUTS, "utf8"));
const roles = readdirSync(join(dir, "files")).sort();
const out = process.env.HUE_CASE_OUTPUT_DIR;
if (process.env.WRITE_UNSUPPORTED) writeFileSync(join(out, "notes.xyz"), "bytes");
writeFileSync(join(out, "Citacion.docx"), "carta de citación para " + process.env.HUE_CASE_KEY);
if (inputs.tipo_diligencia === "Virtual") writeFileSync(join(out, "Cuestionario descargos.docx"), "cuestionario");
if (process.env.LINK_SUMMARY) symlinkSync(process.env.LINK_SUMMARY, join(out, "summary.txt"));
else writeFileSync(join(out, "summary.txt"), "verificación de negrilla: 0 párrafos largos en negrilla\\nadvertencias para revisión: 0\\n");
writeFileSync(join(out, "manifest.json"), JSON.stringify({ primary: "Citacion.docx" }));
process.stdout.write(JSON.stringify({ roles, corpusVisible: existsSync(join(dir, "files", "evaluator_reference")), executionId: typeof process.env.HUE_EXECUTION_ID }));
`;

const adapterSource = `export default async function (_inputs, context) {
  if ("metadata" in context.item) throw new Error("grader metadata reached the direct adapter");
  return { itemKeys: Object.keys(context.item).sort() };
}
`;

describe("hue eval on a document eval set", () => {
  test("file adapters receive case identity but not grader metadata", async () => {
    const standIn = documentStandIn();
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-direct-adapter-"));
    await writeFile(join(cwd, "adapter.mjs"), adapterSource);
    try {
      const run = await hue(
        [
          "--set",
          "gia-d1-citation",
          "--scorer",
          "gia-d1-citation",
          "./adapter.mjs",
          "--content",
          "--json",
          "--wait",
          "30",
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl } },
      );
      expect(run.status).toBe(0);
      expect(standIn.calls.completions[0]).toMatchObject({
        output: { itemKeys: ["externalKey", "id"] },
      });
    } finally {
      standIn.stop();
    }
  }, 30_000);

  test("runs the command in a case directory, uploads its documents and waits for Hue's grader", async () => {
    const standIn = documentStandIn({ gradedAfterPolls: 2 });
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-direct-"));
    await writeFile(join(cwd, "agent.mjs"), agentSource);
    try {
      const result = await hue(
        [
          "--set",
          "gia-d1-citation",
          "--scorer",
          "gia-d1-citation",
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--json",
          "--revision",
          "prompt-v10",
          "--env-file",
          ".env.hue",
          "--wait",
          "30",
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl } },
      ).catch(() => undefined);
      // No env file exists: the run still uses the environment key, and a missing file is a usage error.
      expect(result?.status).toBe(2);
      expect(result?.stderr).toContain("Unable to load .env.hue");
      const run = await hue(
        [
          "--set",
          "gia-d1-citation",
          "--scorer",
          "gia-d1-citation",
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--json",
          "--revision",
          "prompt-v10",
          "--wait",
          "30",
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl } },
      );
      expect(run.stderr).not.toContain("Error");
      expect(run.status).toBe(0);
      const report = JSON.parse(run.stdout) as Record<string, unknown>;
      // The newest published evaluator version was pinned and left to Hue's executor.
      const latest = standIn.scorerVersions[0]!;
      expect(standIn.calls.experiments[0]).toMatchObject({
        datasetVersionId: standIn.dataset.versions[1]!.id,
        scorerVersionIds: [latest.id],
        config: { agentKey: "agent", agentRevision: "prompt-v10" },
      });
      expect(report).toMatchObject({
        mode: "direct",
        deferredScorerVersionIds: [latest.id],
        complete: true,
        totals: { cases: 1, passed: 1 },
      });
      expect(run.stderr).toContain("1 evaluator version left to Hue's executor");
      // Only agent-visible files were downloaded and staged; the corpus never reached the agent.
      expect(standIn.calls.downloads.sort()).toEqual(["Citation_template.docx", "Informe.pdf"]);
      const completion = standIn.calls.completions[0]!;
      expect(completion.state).toBe("succeeded");
      expect((completion.filenames as string[]).sort()).toEqual([
        "Citacion.docx",
        "Cuestionario descargos.docx",
      ]);
      expect(standIn.artifacts.get(completion.primaryArtifactId as string)?.filename).toBe(
        "Citacion.docx",
      );
      expect(standIn.calls.uploads).toBe(2);
      // The output is stored by default: the summary file is the recorded output.
      expect(completion).toMatchObject({
        output: { summary: expect.stringContaining("advertencias para revisión: 0") },
      });
      const content = await hue(
        [
          "--set",
          "gia-d1-citation",
          "--set-version",
          "1",
          "--scorer-version",
          standIn.scorerVersions[1]!.id,
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--no-output",
          "--wait",
          "30",
          "--baseline",
          report.experimentId as string,
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl } },
      );
      expect(content.status).toBe(0);
      expect(standIn.calls.experiments[1]).toMatchObject({
        datasetVersionId: standIn.dataset.versions[0]!.id,
        scorerVersionIds: [standIn.scorerVersions[1]!.id],
      });
      // --no-output keeps the output off the wire; the documents are still uploaded and graded.
      expect(standIn.calls.completions[1]).not.toHaveProperty("output");
      expect(content.stdout).toContain("PASSED");
      expect(content.stdout).toContain("1 of 1 case passed");
      expect(content.stdout).toMatch(/Baseline .*: 0 improved, 0 regressed, 1 unchanged/);
      // The private checkpoint tree is ignored and the case directory holds the staged layout.
      expect(await readFile(join(cwd, ".hue", "eval", ".gitignore"), "utf8")).toBe("*\n");
    } finally {
      standIn.stop();
    }
  }, 120_000);

  test("a summary linked to a host file fails the case instead of sending the file to Hue", async () => {
    const standIn = documentStandIn();
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-direct-link-"));
    await writeFile(join(cwd, "agent.mjs"), agentSource);
    const hostFile = join(cwd, "host-secret.txt");
    await writeFile(hostFile, "host secret: never sent");
    try {
      const run = await hue(
        [
          "--set",
          "gia-d1-citation",
          "--scorer",
          "gia-d1-citation",
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--content",
          "--json",
          "--wait",
          "5",
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl, LINK_SUMMARY: hostFile } },
      );
      expect(run.status).toBe(1);
      expect(standIn.calls.completions[0]).toMatchObject({
        state: "error",
        error: {
          type: "TargetError",
          message: "output/summary.txt is not a regular file; the agent must write it itself",
        },
        filenames: [],
      });
      expect(JSON.stringify(standIn.calls.completions)).not.toContain("host secret");
      for (const stored of standIn.artifacts.values())
        expect(Buffer.from(stored.bytes ?? []).toString()).not.toContain("host secret");
    } finally {
      standIn.stop();
    }
  }, 60_000);

  test("an unsupported generated file and a failing verdict are reported as the case's own result", async () => {
    const standIn = documentStandIn({ verdict: "fail" });
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-direct-"));
    await writeFile(join(cwd, "agent.mjs"), agentSource);
    try {
      const unsupported = await hue(
        [
          "--set",
          standIn.dataset.id,
          "--scorer",
          standIn.scorerVersions[0]!.id.length ? "gia-d1-citation" : "",
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--json",
          "--wait",
          "5",
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl, WRITE_UNSUPPORTED: "1" } },
      );
      expect(unsupported.status).toBe(1);
      // The error message is stored by default, with the type and the empty upload.
      expect(standIn.calls.completions[0]).toMatchObject({
        state: "error",
        error: {
          type: "TargetError",
          message: expect.stringContaining("Hue does not accept as generated documents"),
        },
        filenames: [],
      });
      const report = JSON.parse(unsupported.stdout) as { cases: { state: string }[] };
      expect(report.cases[0]!.state).not.toBe("passed");
      // With --no-output it stays off the wire; the type and the empty upload remain.
      const quiet = await hue(
        [
          "--set",
          standIn.dataset.id,
          "--scorer",
          "gia-d1-citation",
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--no-output",
          "--wait",
          "5",
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl, WRITE_UNSUPPORTED: "1" } },
      );
      expect(quiet.status).toBe(1);
      expect(standIn.calls.completions[1]).toMatchObject({
        state: "error",
        error: { type: "TargetError" },
        filenames: [],
      });
      expect(standIn.calls.completions[1]).not.toHaveProperty("error.message");
      const failing = await hue(
        [
          "--set",
          "gia-d1-citation",
          "--scorer",
          "gia-d1-citation",
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--wait",
          "5",
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl } },
      );
      expect(failing.status).toBe(1);
      expect(failing.stdout).toContain("FAILED");
      expect(failing.stdout).toContain("2 error(s)");
      // --mode simulation on a set without worlds is refused before any experiment is created.
      const before = standIn.calls.experiments.length;
      const forced = await hue(
        ["--set", "gia-d1-citation", "--scorer", "nope", "--command", "true", "--wait", "1"],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl } },
      );
      expect(forced.status).toBe(2);
      expect(forced.stderr).toContain('No evaluator matches "nope"');
      expect(standIn.calls.experiments).toHaveLength(before);
    } finally {
      standIn.stop();
    }
  }, 120_000);

  test("a case whose trace Hue refuses fails and exits 1 even when its grader passes it", async () => {
    // The grader never reads the execution state, so only the CLI can keep the case failing.
    const standIn = documentStandIn({ refuseTraces: true, ignoreExecutionState: true });
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-direct-"));
    await writeFile(join(cwd, "agent.mjs"), agentSource);
    try {
      const result = await hue(
        [
          "--set",
          standIn.dataset.id,
          "--scorer",
          "gia-d1-citation",
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--json",
          "--content",
          "--wait",
          "5",
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /\] telemetry not accepted, case failed: telemetry_not_accepted: traces failed \d+ \(HTTP 400\)/,
      );
      // Completed as failed, without the output or documents a grader could pass.
      const completion = standIn.calls.completions[0]!;
      expect(completion).toMatchObject({
        state: "error",
        error: { type: "TelemetryNotAccepted" },
        traceEvidence: "omit",
        filenames: [],
      });
      expect(completion).not.toHaveProperty("output");
      expect(completion).not.toHaveProperty("artifactIds");
      const report = JSON.parse(result.stdout) as {
        cases: Record<string, unknown>[];
        totals: { passed: number; error: number };
      };
      expect(report.cases[0]).toMatchObject({
        state: "error",
        passed: false,
        telemetry: { code: "telemetry_not_accepted" },
      });
      expect(report.totals).toMatchObject({ passed: 0, error: 1 });
    } finally {
      standIn.stop();
    }
  }, 120_000);

  test("a direct case's stored answer and text documents never keep the project key it was handed", async () => {
    const standIn = documentStandIn();
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-direct-"));
    await writeFile(
      join(cwd, "leaky.mjs"),
      `import { writeFileSync } from "node:fs";
const out = process.env.HUE_CASE_OUTPUT_DIR, key = process.env.HUE_API_KEY;
writeFileSync(out + "/result.json", JSON.stringify({ key }));
writeFileSync(out + "/notes.txt", "\\ufeffcalled with " + key + "\\n");
writeFileSync(out + "/rows.json", JSON.stringify([{ key }]));
writeFileSync(out + "/latin1.txt", Buffer.concat([Buffer.from([0xff]), Buffer.from(key)]));
writeFileSync(out + "/chart.png", Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.from(key)]));
process.stdout.write(key);
`,
    );
    try {
      const result = await hue(
        [
          "--set",
          standIn.dataset.id,
          "--scorer",
          "gia-d1-citation",
          "--command",
          `${process.execPath} ${join(cwd, "leaky.mjs")}`,
          "--allow-hue-credentials",
          "--wait",
          "5",
        ],
        { cwd, env: { HUE_BASE_URL: standIn.baseUrl } },
      );
      expect(result.stdout).not.toContain(key);
      expect(standIn.calls.completions[0]).toMatchObject({ output: { key: "[redacted]" } });
      expect(JSON.stringify(standIn.calls.completions)).not.toContain(key);
      // UTF-8 text documents are cleared of it, byte order mark kept; other files are not read.
      const uploaded = (name: string) =>
        Buffer.from(
          [...standIn.artifacts.values()].find((stored) => stored.filename === name)!.bytes!,
        );
      expect(uploaded("notes.txt").toString()).toBe("\ufeffcalled with [redacted]\n");
      expect(JSON.parse(uploaded("rows.json").toString())).toEqual([{ key: "[redacted]" }]);
      expect(uploaded("latin1.txt").subarray(1).toString()).toBe(key);
      expect(uploaded("chart.png").subarray(2).toString()).toBe(key);
    } finally {
      standIn.stop();
    }
  }, 120_000);

  test("evaluators that do not apply to a case neither pass nor fail it", async () => {
    const run = async (notApplicable: { versions: number[]; forged?: boolean }) => {
      const standIn = documentStandIn({ notApplicable });
      const cwd = await mkdtemp(join(tmpdir(), "hue-eval-direct-"));
      await writeFile(join(cwd, "agent.mjs"), agentSource);
      try {
        const [newest, older] = standIn.scorerVersions.map((version) => version.id);
        const result = await hue(
          [
            "--set",
            standIn.dataset.id,
            "--scorer-version",
            newest!,
            "--scorer-version",
            older!,
            "--command",
            `${process.execPath} ${join(cwd, "agent.mjs")}`,
            "--json",
            "--wait",
            "5",
          ],
          { cwd, env: { HUE_BASE_URL: standIn.baseUrl } },
        );
        const report = JSON.parse(result.stdout) as {
          cases: Record<string, unknown>[];
          totals: Record<string, number>;
        };
        return { status: result.status, report, ids: [newest!, older!] };
      } finally {
        standIn.stop();
      }
    };
    // Every evaluator is pinned; the case passes the one that applies, and the other is n/a.
    const mixed = await run({ versions: [1] });
    expect(mixed.status).toBe(0);
    expect(mixed.report.cases[0]).toMatchObject({
      state: "passed",
      passed: true,
      notApplicable: [mixed.ids[1]],
    });
    expect(mixed.report.totals).toMatchObject({ passed: 1, notApplicable: 1, skipped: 0 });
    // A case no pinned evaluator applies to is an error that says so.
    const none = await run({ versions: [0, 1] });
    expect(none.status).toBe(1);
    expect(none.report.cases[0]).toMatchObject({ state: "error", passed: false });
    expect(none.report.cases[0]!.explanations).toContain(
      "No pinned evaluator applies to this case (they need outcome_criteria); pin one that grades it",
    );
    // The same skipped result and evidence without Hue's flag is an ordinary skip, not n/a.
    const forged = await run({ versions: [0, 1], forged: true });
    expect(forged.status).toBe(1);
    expect(forged.report.cases[0]).toMatchObject({ state: "skipped", notApplicable: [] });
    expect(forged.report.totals).toMatchObject({ skipped: 1, notApplicable: 0, error: 0 });
  }, 120_000);

  test("an interrupted run resumes the saved experiment without invoking the agent again", async () => {
    const standIn = documentStandIn({ failCompletions: 1 });
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-direct-"));
    await writeFile(join(cwd, "agent.mjs"), agentSource);
    const args = [
      "--set",
      "gia-d1-citation",
      "--scorer",
      "gia-d1-citation",
      "--command",
      `${process.execPath} ${join(cwd, "agent.mjs")}`,
      "--json",
      "--revision",
      "prompt-v10",
      "--wait",
      "30",
    ];
    try {
      const interrupted = await hue(args, { cwd, env: { HUE_BASE_URL: standIn.baseUrl } });
      expect(interrupted.status).toBe(1);
      expect(standIn.calls.completions).toHaveLength(0);
      const uploadsBefore = standIn.calls.uploads;
      const resumed = await hue(args, { cwd, env: { HUE_BASE_URL: standIn.baseUrl } });
      expect(resumed.status).toBe(0);
      // One experiment and one started execution across both invocations: the rerun finished
      // the saved run from its checkpoints instead of spawning the agent or uploading again.
      expect(standIn.calls.experiments).toHaveLength(1);
      expect(standIn.calls.requests.filter((request) => request.endsWith("/start"))).toHaveLength(
        1,
      );
      expect(standIn.calls.uploads).toBe(uploadsBefore);
      expect(standIn.calls.completions).toHaveLength(1);
      const report = JSON.parse(resumed.stdout) as Record<string, unknown>;
      expect(report).toMatchObject({ complete: true, totals: { cases: 1, passed: 1 } });
    } finally {
      standIn.stop();
    }
  }, 120_000);

  test("stageDirectCase and collectDirectOutputs implement the case-directory protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "hue-direct-"));
    const source = join(root, "Informe.pdf");
    await writeFile(source, "%PDF-1.4");
    const layout = await stageDirectCase(join(root, "scratch"), {
      inputs: { query: "q" },
      config: { agentRevision: "r1" },
      item: { id: "case-id", externalKey: "case-key" },
      executionId: "exec-1",
      files: [
        {
          artifactId: "a",
          role: "source",
          filename: "Informe.pdf",
          contentType: "application/pdf",
          byteSize: 8,
          sha256: "0".repeat(64),
          path: source,
        },
        {
          artifactId: "b",
          role: "source",
          filename: "Informe.pdf",
          contentType: "application/pdf",
          byteSize: 8,
          sha256: "0".repeat(64),
          path: source,
        },
      ],
    });
    expect(layout.files.map((file) => file.filename)).toEqual(["Informe.pdf", "Informe (2).pdf"]);
    expect(JSON.parse(await readFile(layout.inputsPath, "utf8"))).toEqual({ query: "q" });
    expect(
      JSON.parse(await readFile(join(layout.caseDirectory, "case.json"), "utf8")),
    ).toMatchObject({
      id: "case-id",
      externalKey: "case-key",
      executionId: "exec-1",
      config: { agentRevision: "r1" },
    });
    // Nothing written: stdout stands in for the answer.
    const empty = await collectDirectOutputs(layout.outputDirectory, "answer text");
    expect(empty.output).toBe("answer text");
    expect(empty.files).toEqual([]);
    await writeFile(join(layout.outputDirectory, "result.json"), JSON.stringify({ ok: true }));
    await writeFile(join(layout.outputDirectory, "Letter.docx"), "letter");
    await writeFile(join(layout.outputDirectory, "~$Letter.docx"), "lock");
    await writeFile(join(layout.outputDirectory, ".DS_Store"), "junk");
    const single = await collectDirectOutputs(layout.outputDirectory);
    expect(single.output).toEqual({ ok: true });
    expect(single.files).toEqual([
      {
        bytes: new Uint8Array(Buffer.from("letter")),
        filename: "Letter.docx",
        contentType: docx,
        primary: true,
      },
    ]);
    await writeFile(join(layout.outputDirectory, "Anexo.pdf"), "%PDF");
    const two = await collectDirectOutputs(layout.outputDirectory);
    expect(two.files.map((file) => [file.filename, file.primary ?? false])).toEqual([
      ["Anexo.pdf", false],
      ["Letter.docx", false],
    ]);
    // Files in subdirectories are documents too; hidden folders stay skipped.
    await mkdir(join(layout.outputDirectory, "anexos", ".cache"), { recursive: true });
    await writeFile(join(layout.outputDirectory, "anexos", "Soporte.pdf"), "%PDF");
    await writeFile(join(layout.outputDirectory, "anexos", ".cache", "tmp.bin"), "junk");
    const nested = await collectDirectOutputs(layout.outputDirectory);
    expect(nested.files.map((file) => file.filename)).toEqual([
      "Anexo.pdf",
      "Letter.docx",
      "anexos%2FSoporte.pdf",
    ]);
    expect(Buffer.from(nested.files[2]!.bytes!).toString()).toBe("%PDF");
    await writeFile(
      join(layout.outputDirectory, "manifest.json"),
      JSON.stringify({ primary: "anexos/Soporte.pdf" }),
    );
    const nestedPrimary = await collectDirectOutputs(layout.outputDirectory);
    expect(nestedPrimary.files.find((file) => file.primary)?.filename).toBe("anexos%2FSoporte.pdf");
    await writeFile(
      join(layout.outputDirectory, "manifest.json"),
      JSON.stringify({ primary: "Missing.docx" }),
    );
    await expect(collectDirectOutputs(layout.outputDirectory)).rejects.toThrow("Missing.docx");
    await writeFile(
      join(layout.outputDirectory, "manifest.json"),
      JSON.stringify({ primary: "Letter.docx", output: { fromManifest: true } }),
    );
    const declared = await collectDirectOutputs(layout.outputDirectory);
    expect(declared.output).toEqual({ fromManifest: true });
    expect(declared.files.find((file) => file.primary)?.filename).toBe("Letter.docx");
    await writeFile(join(layout.outputDirectory, "Empty.docx"), "");
    await expect(collectDirectOutputs(layout.outputDirectory)).rejects.toThrow("empty file");
  });
});
