import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Installed-package check for direct file cases: the runner downloads and verifies the pinned
// inputs, publishes the target's generated document through the artifact API, hands every file
// to a local scorer during the run and again on a later rescore, and records a declared file the
// target could not deliver as the target's own error. For a case pinned to a world, the worker
// hands the agent its agent-visible files with the world (`environment-files:v1`), uploads the
// document it returns, removes the case's files afterwards and refuses bytes that differ from
// the manifest before any execution or world exists. The loopback server mirrors the request
// and response shapes of tests/files.test.ts and tests/environment-files.test.ts.
const [consumer] = process.argv.slice(2);
if (!consumer) throw new Error("Provide the installed consumer path");
const require = createRequire(join(consumer, "package.json"));
const { createHue } = require("@hue-run/sdk");
const { createEnvironmentClient } = require("@hue-run/sdk/environment");
const {
  builtins,
  CaseFileError,
  createEvaluationClient,
  defineLocalScorer,
  localAgentCapabilities,
  rescore,
  runExperiment,
  runLocalAgent,
  withFiles,
} = require("@hue-run/sdk/evals");

const key = "synthetic-files-key";
const worldToken = `hue_world_${"c".repeat(64)}.${"s".repeat(43)}`;
const digest = "c".repeat(64);
const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pdf = "application/pdf";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const version = (definition) => ({ id: randomUUID(), contentDigest: digest, definition });
// The runner hands the target validated JSON as null-prototype objects; compare values only.
const plain = (value) => JSON.parse(JSON.stringify(value));
const scratch = await mkdtemp(join(tmpdir(), "hue-files-installed-"));
let checkpoints = 0;
const checkpointDirectory = () => join(scratch, `checkpoint-${++checkpoints}`);
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Synthetic control plane: one frozen case with pinned input files, artifacts and executions.
 * `world` pins the case to a world and serves the worker queue; `tamper` alters the source's
 * downloaded bytes at the pinned size; `sourceName` renames the source in the manifest. */
async function fixture(scorers, options = {}) {
  const projectId = randomUUID();
  const datasetVersionId = randomUUID();
  const inputs = {
    source: {
      id: randomUUID(),
      role: "source",
      filename: options.sourceName ?? "Informe.pdf",
      contentType: pdf,
      bytes: Buffer.from("%PDF-1.7 synthetic incident report"),
    },
    template: {
      id: randomUUID(),
      role: "attached_template",
      filename: "Plantilla.docx",
      contentType: docx,
      bytes: Buffer.from("PK synthetic institutional template"),
    },
    // Evaluator-only: reaches scorers, never the target.
    evaluatorOnly: {
      id: randomUUID(),
      role: "org_template",
      filename: "Org.docx",
      contentType: docx,
      bytes: Buffer.from("PK synthetic organization template"),
    },
  };
  const item = {
    id: randomUUID(),
    datasetVersionId,
    externalKey: "letter-1",
    inputs: { query: "Draft the reply letter", topic: "warning" },
    hasExpected: false,
    metadata: { letter: { id: "letter-1" } },
    environmentVersionId: options.world ? randomUUID() : null,
    artifactManifestId: randomUUID(),
    inputFiles: Object.values(inputs).map((file) => ({
      artifactId: file.id,
      role: file.role,
      filename: file.filename,
      contentType: file.contentType,
      byteSize: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    })),
  };
  const experiment = {
    id: randomUUID(),
    name: "documents",
    datasetVersionId,
    config: { variant: "baseline" },
    configDigest: digest,
    evaluation: {
      id: randomUUID(),
      name: "default",
      scorerVersions: scorers,
      itemCount: 1,
      scores: { scored: 0, error: 0, skipped: 0, pending: scorers.length },
    },
    caseCount: 1,
    finishedAt: null,
    execution: { unstarted: 1, started: 0, uncertain: 0, succeeded: 0, error: 0, cancelled: 0 },
  };
  const artifacts = new Map();
  for (const input of Object.values(inputs))
    artifacts.set(input.id, {
      id: input.id,
      filename: input.filename,
      contentType: input.contentType,
      byteSize: input.bytes.byteLength,
      sha256: sha256(input.bytes),
      state: "ready",
      copyState: "acknowledged",
      bytes: input.bytes,
    });
  const reservations = new Map();
  const executions = new Map();
  const subjects = new Map();
  const scoringRuns = new Map();
  const storedResults = new Map();
  const worlds = new Map();
  const queue = options.world ? [{ runId: randomUUID(), state: "queued" }] : [];
  const calls = {
    starts: 0,
    worldCreates: 0,
    finishes: [],
    registrations: [],
    localRuns: [],
    environmentReads: 0,
    downloads: [],
    reserves: [],
    uploads: [],
    artifactCompletions: [],
    completions: [],
    results: [],
  };
  // Server-side contract failures are collected so a tolerant client cannot hide them.
  const failures = [];
  const reservation = (stored) => ({
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
  const server = createServer(async (request, response) => {
    const send = (value, status = 200) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    const status = (code) => {
      response.statusCode = code;
      response.end();
    };
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/blob/")) {
        // Storage capability: the Hue key must never reach it.
        assert.equal(request.headers.authorization, undefined);
        assert.equal(request.method, "PUT");
        const stored = artifacts.get(url.pathname.slice("/blob/".length));
        assert.ok(stored, "Uploads target a reserved artifact");
        stored.bytes = new Uint8Array(await body(request));
        calls.uploads.push(stored.id);
        return send({ ok: true });
      }
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      const path = url.pathname.replace("/api/v1", "");
      if (path === "/projects/current")
        return send({
          id: projectId,
          name: "Synthetic",
          slug: "synthetic",
          organizationId: randomUUID(),
        });
      if (path.startsWith("/otlp/")) {
        await body(request);
        response.statusCode = 200;
        response.setHeader("content-type", "application/x-protobuf");
        return response.end();
      }
      const download = /^\/artifacts\/([^/]+)\/download$/.exec(path);
      if (download) {
        const stored = artifacts.get(download[1]);
        if (!stored?.bytes || stored.state !== "ready") return status(404);
        calls.downloads.push(stored.id);
        response.statusCode = 200;
        response.setHeader("content-type", "application/octet-stream");
        const bytes = Buffer.from(stored.bytes);
        if (options.tamper && stored.id === inputs.source.id) bytes.fill(0x41, 0, 4);
        return response.end(bytes);
      }
      const raw = request.method === "GET" ? undefined : await body(request);
      const payload = raw?.length ? JSON.parse(raw) : {};
      if (path === "/artifacts" && request.method === "POST") {
        calls.reserves.push(payload);
        const reservationKey = String(payload.idempotencyKey);
        let id = reservations.get(reservationKey);
        if (!id) {
          id = randomUUID();
          reservations.set(reservationKey, id);
          artifacts.set(id, {
            id,
            filename: String(payload.filename),
            contentType: String(payload.contentType),
            byteSize: Number(payload.byteSize),
            sha256: String(payload.sha256),
            state: "reserved",
            copyState: "none",
          });
        }
        return send(reservation(artifacts.get(id)), 201);
      }
      const artifact = /^\/artifacts\/([^/]+)(?:\/(upload|complete))?$/.exec(path);
      if (artifact) {
        const stored = artifacts.get(artifact[1]);
        if (!stored) return status(404);
        if (!artifact[2]) return send(reservation(stored));
        assert.equal(request.method, "POST");
        if (artifact[2] === "upload")
          return send({
            uploadUrl: `http://127.0.0.1:${server.address().port}/blob/${stored.id}`,
            method: "PUT",
            headers: { "content-type": stored.contentType, "x-vercel-blob-access": "private" },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        if (!stored.bytes) return status(409);
        if (stored.bytes.byteLength !== stored.byteSize || sha256(stored.bytes) !== stored.sha256)
          return send({ error: "mismatch" }, 409);
        stored.state = "ready";
        stored.copyState = "acknowledged";
        calls.artifactCompletions.push(stored.id);
        return send(reservation(stored));
      }
      if (path === `/dataset-versions/${datasetVersionId}`)
        return send({
          id: datasetVersionId,
          datasetId: randomUUID(),
          version: 1,
          revision: 1,
          frozenAt: new Date().toISOString(),
          contentDigest: digest,
        });
      if (path === `/experiments/${experiment.id}`) return send(experiment);
      if (path === `/experiments/${experiment.id}/items`)
        return send({
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
      if (path === `/experiments/${experiment.id}/items/${item.id}`) return send(item);
      if (path === `/experiments/${experiment.id}/items/${item.id}/start`) {
        calls.starts++;
        const execution = {
          id: randomUUID(),
          state: "started",
          attempt: 1,
          traceExternalId: String(payload.traceExternalId),
        };
        executions.set(execution.id, execution);
        return send(execution);
      }
      if (path === `/experiments/${experiment.id}/finish`)
        return send({ id: experiment.id, finishedAt: new Date().toISOString() });
      const execution = /^\/experiment-executions\/([^/]+)(\/complete)?$/.exec(path);
      if (execution) {
        const current = executions.get(execution[1]);
        if (!current) return status(404);
        if (!execution[2]) return send(current);
        const ids = payload.artifactIds ?? [];
        if (ids.some((id) => artifacts.get(id)?.state !== "ready")) return status(409);
        // Completion refuses an open linked world.
        if (
          [...worlds.values()].some(
            (world) => world.executionId === current.id && world.status === "open",
          )
        )
          return status(409);
        current.state = payload.state;
        calls.completions.push(payload);
        const subjectId = randomUUID();
        const hasOutput = Object.hasOwn(payload, "output");
        // Freeze the manifest the way the server does: case inputs plus the target's outputs.
        const files = [
          ...item.inputFiles,
          ...ids.map((id) => {
            const stored = artifacts.get(id);
            return {
              artifactId: id,
              role: "output",
              filename: stored.filename,
              contentType: stored.contentType,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
            };
          }),
        ];
        subjects.set(subjectId, {
          id: subjectId,
          executionId: current.id,
          inputs: item.inputs,
          hasOutput,
          ...(hasOutput ? { output: payload.output } : {}),
          hasExpected: false,
          metadata: item.metadata,
          contentDigest: digest,
          outputEvidence: hasOutput ? "available" : "unavailable",
          executionState: current.state,
          traceSnapshotId: null,
          caseId: item.id,
          datasetVersionId,
          caseExternalKey: item.externalKey,
          experimentId: experiment.id,
          attempt: 1,
          traceEvidence: "omitted",
          traceExternalId: current.traceExternalId,
          omissionReason: null,
          environmentVersionId: item.environmentVersionId,
          files,
          primaryArtifactId: payload.primaryArtifactId ?? null,
        });
        return send({
          executionId: current.id,
          subjectId,
          evaluationItemId: randomUUID(),
          traceSnapshotId: payload.traceEvidence === "omit" ? null : randomUUID(),
        });
      }
      const evidence = /^\/experiment-executions\/([^/]+)\/environment(\/steps)?$/.exec(path);
      if (evidence) {
        calls.environmentReads++;
        const linked = [...worlds.entries()].find(([, world]) => world.executionId === evidence[1]);
        if (!linked) return status(503);
        if (linked[1].status === "open") return status(409);
        if (evidence[2]) return send({ items: [], nextCursor: null });
        return send({
          validity: "not_assessed",
          coverageGap: null,
          runId: linked[0],
          executionId: evidence[1],
          environmentVersionId: item.environmentVersionId,
          definitionDigest: digest,
          seed: "e".repeat(32),
          status: linked[1].status,
          stepCount: 0,
          stateDigest: digest,
          initialState: { collections: {} },
          finalState: { collections: {} },
        });
      }
      if (path === "/local-agent-worker/register") {
        calls.registrations.push(payload);
        return send({
          id: randomUUID(),
          ...payload,
          enabled: true,
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      }
      if (path === "/local-agent-worker/claim") {
        const queued = queue.find((run) => run.state === "queued");
        if (!queued) return send(null);
        queued.state = "claimed";
        return send({ runId: queued.runId, experimentId: experiment.id });
      }
      if (path === "/local-agent-worker/runs/heartbeat")
        return send({ runId: payload.runId, active: true });
      if (path === "/local-agent-worker/runs/complete") {
        calls.localRuns.push(payload);
        return send({ runId: payload.runId, state: payload.state });
      }
      if (path === "/environment-runs" && options.world) {
        calls.worldCreates++;
        const id = randomUUID();
        worlds.set(id, { executionId: String(payload.executionId), status: "open" });
        const mirror = `http://127.0.0.1:${server.address().port}/api/sim/gmailmcp.googleapis.com/mcp/v1`;
        return send({
          id,
          environmentVersionId: item.environmentVersionId,
          clockNs: "0",
          stateDigest: digest,
          maxSteps: 50,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          actions: [],
          worldId: id,
          token: worldToken,
          lifecycle: "live",
          completingUntil: null,
          baggage: `hue-world=${id}`,
          traceparent: payload.traceparent ?? null,
          surfaces: [
            {
              provider: "google.gmail",
              surface: "google.gmail/mcp",
              providerInstanceKey: "gmail-primary",
              url: mirror,
              alias: null,
            },
          ],
          env: { HUE_WORLD_ID: id, HUE_WORLD_TOKEN: worldToken, BAGGAGE: `hue-world=${id}` },
          mcpConfig: {
            mcpServers: {
              "gmail-primary": {
                type: "http",
                url: mirror,
                headers: { Authorization: `Bearer ${worldToken}` },
              },
            },
          },
          connection: null,
        });
      }
      const worldRun = /^\/environment-runs\/([^/]+)(\/finish)?$/.exec(path);
      if (worldRun && worlds.has(worldRun[1])) {
        const world = worlds.get(worldRun[1]);
        if (worldRun[2]) {
          if (world.status !== "open") return status(409);
          world.status = String(payload.status);
          calls.finishes.push(world.status);
          return send({
            id: worldRun[1],
            status: world.status,
            stepCount: 0,
            stateDigest: digest,
            sealedAt: new Date().toISOString(),
          });
        }
        return send({
          id: worldRun[1],
          environmentVersionId: item.environmentVersionId,
          executionId: world.executionId,
          seed: "e".repeat(32),
          status: world.status,
          stepCount: 0,
          maxSteps: 50,
          clockNs: "0",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          createdAt: new Date().toISOString(),
          sealedAt: world.status === "open" ? null : new Date().toISOString(),
          stateDigest: digest,
          finalState: { collections: {} },
          validity: "not_assessed",
          coverageGap: null,
        });
      }
      if (path === "/evaluation-runs" && request.method === "POST") {
        const id = randomUUID();
        scoringRuns.set(id, {
          scorerVersions: scorers.filter((pin) => payload.scorerVersionIds.includes(pin.id)),
          items: payload.subjectIds.map((subjectId) => ({
            id: randomUUID(),
            subjectId,
            hasOutput: subjects.get(subjectId)?.hasOutput ?? false,
            traceSnapshotId: null,
          })),
        });
        return send({ id });
      }
      const scoring = /^\/evaluation-runs\/([^/]+)(?:\/(items|results))?$/.exec(path);
      if (scoring) {
        const run = scoringRuns.get(scoring[1]);
        if (scoring[2] === "results") {
          const results = storedResults.get(scoring[1]) ?? [];
          if (request.method === "GET") {
            // One result per page exercises receipt lookup beyond the first page.
            const after = url.searchParams.get("after");
            const offset = after ? results.findIndex((result) => result.id === after) + 1 : 0;
            const items = results.slice(offset, offset + 1);
            return send({ items, nextCursor: offset + 1 < results.length ? items[0].id : null });
          }
          const submitted = payload.results;
          if (
            submitted.some((score) =>
              results.some(
                (result) =>
                  result.itemId === score.evaluationItemId &&
                  result.scorerVersionId === score.scorerVersionId,
              ),
            )
          )
            return status(409);
          const saved = submitted.map((score) => ({
            id: randomUUID(),
            itemId: score.evaluationItemId,
            scorerVersionId: score.scorerVersionId,
            state: score.state,
          }));
          storedResults.set(scoring[1], [...results, ...saved]);
          calls.results.push(...submitted);
          return send({ ids: saved.map((result) => result.id) });
        }
        if (!run) return status(404);
        if (scoring[2] === "items") return send({ items: run.items, nextCursor: null });
        return send({
          id: scoring[1],
          name: "grade again",
          scorerVersions: run.scorerVersions,
          itemCount: run.items.length,
          scores: { scored: 0, error: 0, skipped: 0, pending: run.items.length },
        });
      }
      const subject = /^\/evaluation-subjects\/([^/]+)$/.exec(path);
      if (subject) {
        const found = subjects.get(subject[1]);
        return found ? send(found) : status(404);
      }
      throw new Error(`Unexpected request ${request.method} ${path}`);
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) send({ error: "Synthetic files contract failed" }, 500);
      else response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    artifacts,
    item,
    inputs,
    experiment,
    subjects,
    assertClean: () =>
      assert.equal(
        failures.length,
        0,
        `Synthetic server contract failed:\n${failures.map((error) => error?.stack ?? String(error)).join("\n")}`,
      ),
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// A throwing callback becomes a LocalScorerError result, so the grader only records what it
// saw; every assertion runs afterwards.
const graderCalls = [];
const grader = defineLocalScorer({
  source: "installed document grader",
  entrypoint: "grade",
  metrics: [{ name: "letter_bytes", type: "number", min: 0 }],
  async score(context) {
    const letter = context.files?.find((file) => file.role === "output" && file.primary);
    const bytes = letter ? await readFile(letter.path) : new Uint8Array();
    graderCalls.push({
      files: context.files,
      hasOutput: context.hasOutput,
      letterSha256: sha256(bytes),
    });
    return {
      state: "scored",
      metrics: [{ name: "letter_bytes", value: bytes.byteLength, passed: bytes.byteLength > 0 }],
      explanation: letter ? `Graded ${letter.filename}` : "No letter",
    };
  },
});
const graderVersion = version(grader.definition);
const letterBytes = Buffer.from("PK synthetic generated letter");
const letterName = "Résumé final.docx";
const fileRoles = (files) => files.map((file) => [file.role, file.primary ?? false]).sort();
const expectedScorerRoles = [
  ["attached_template", false],
  ["org_template", false],
  ["output", true],
  ["source", false],
];
const letterMetric = [{ name: "letter_bytes", value: letterBytes.byteLength, passed: true }];

try {
  const f = await fixture([graderVersion, version(builtins.exactMatch())]);
  const client = createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl });
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "installed-files",
    captureContent: false,
  });
  try {
    const seen = {};
    const report = await runExperiment({
      client,
      hue,
      experimentId: f.experiment.id,
      checkpointDirectory: checkpointDirectory(),
      persistResultContent: true,
      // A case without a world must not be reported as missing environment evidence.
      environmentEvidence: "when_pinned",
      traceEvidence: { mode: "required" },
      scorers: [grader],
      async target(inputs, context) {
        seen.target = { inputs, files: context.files, outputDirectory: context.outputDirectory };
        const letter = join(context.outputDirectory, "Letter.docx");
        await writeFile(letter, letterBytes);
        return withFiles({ summary: "ok" }, [
          { path: letter, filename: letterName, contentType: docx, primary: true },
        ]);
      },
    });
    f.assertClean();
    assert.equal(report.runId, f.experiment.evaluation.id);
    assert.equal(report.subjectIds.length, 1);
    assert.equal(report.resultIds.length, 2);
    assert.equal(f.calls.environmentReads, 0);
    // The target saw the task inputs and exactly the agent-visible files, verified on disk.
    assert.deepEqual(plain(seen.target.inputs), f.item.inputs);
    assert.deepEqual(fileRoles(seen.target.files), [
      ["attached_template", false],
      ["source", false],
    ]);
    for (const file of seen.target.files) {
      const pinned = f.item.inputFiles.find((entry) => entry.artifactId === file.artifactId);
      assert.ok(pinned, "Target files carry pinned artifact identities");
      const { path, ...identity } = file;
      assert.deepEqual(identity, pinned);
      const bytes = await readFile(path);
      assert.equal(bytes.byteLength, pinned.byteSize);
      assert.equal(sha256(bytes), pinned.sha256);
      assert.equal((await stat(path)).mode & 0o077, 0);
    }
    assert.ok((await stat(seen.target.outputDirectory)).isDirectory());
    // Every pinned input was downloaded once, including the evaluator-only template.
    assert.deepEqual(
      [...f.calls.downloads].sort(),
      Object.values(f.inputs)
        .map((input) => input.id)
        .sort(),
    );
    // The generated file was reserved with its verified identity, uploaded and completed.
    assert.equal(f.calls.reserves.length, 1);
    const { idempotencyKey, ...reserved } = f.calls.reserves[0];
    assert.ok(typeof idempotencyKey === "string" && idempotencyKey.length > 0);
    assert.deepEqual(reserved, {
      filename: letterName,
      contentType: docx,
      byteSize: letterBytes.byteLength,
      sha256: sha256(letterBytes),
    });
    assert.equal(f.calls.uploads.length, 1);
    assert.deepEqual(f.calls.artifactCompletions, f.calls.uploads);
    assert.equal(f.calls.completions.length, 1);
    const completion = f.calls.completions[0];
    assert.equal(completion.state, "succeeded");
    assert.deepEqual(completion.output, { summary: "ok" });
    assert.equal(completion.traceEvidence, "required");
    assert.deepEqual(completion.artifactIds, f.calls.uploads);
    assert.equal(completion.primaryArtifactId, f.calls.uploads[0]);
    const primary = f.artifacts.get(completion.primaryArtifactId);
    assert.equal(primary.state, "ready");
    assert.equal(primary.filename, letterName);
    assert.ok(Buffer.from(primary.bytes).equals(letterBytes));
    // The scorer saw every input plus the generated file with verified identities.
    assert.equal(graderCalls.length, 1);
    const graded = graderCalls[0];
    assert.equal(graded.hasOutput, true);
    assert.deepEqual(fileRoles(graded.files), expectedScorerRoles);
    const output = graded.files.find((file) => file.role === "output");
    assert.deepEqual(
      { ...output, path: undefined },
      {
        artifactId: completion.primaryArtifactId,
        role: "output",
        filename: letterName,
        contentType: docx,
        byteSize: letterBytes.byteLength,
        sha256: sha256(letterBytes),
        primary: true,
        path: undefined,
      },
    );
    assert.equal(graded.letterSha256, sha256(letterBytes));
    assert.equal(f.calls.results.length, 2);
    const scored = f.calls.results.find((result) => result.state === "scored");
    assert.equal(scored.scorerVersionId, graderVersion.id);
    assert.equal(scored.sourceDigest, grader.definition.sourceDigest);
    assert.deepEqual(scored.metrics, letterMetric);
    // Exact match has a JSON output but no reference; it is skipped, never a zero.
    assert.equal(
      f.calls.results.find((result) => result.state === "skipped")?.explanation,
      "Reference evidence is unavailable",
    );
    console.log(
      "Installed direct file case: pinned inputs verified, generated file published, files graded",
    );

    // Grade the saved subject again: the frozen manifest holds inputs and the output.
    const scoring = await client.createEvaluationRun({
      idempotencyKey: randomUUID(),
      name: "Grade again",
      subjectIds: report.subjectIds,
      scorerVersionIds: [graderVersion.id],
    });
    const downloadsBefore = f.calls.downloads.length;
    const resultsBefore = f.calls.results.length;
    const options = {
      client,
      runId: scoring.id,
      checkpointDirectory: checkpointDirectory(),
      persistResultContent: true,
      environmentEvidence: "when_pinned",
      scorers: [grader],
    };
    const regraded = await rescore(options);
    f.assertClean();
    assert.equal(regraded.runId, scoring.id);
    assert.equal(regraded.resultIds.length, 1);
    assert.equal(f.calls.environmentReads, 0);
    assert.equal(graderCalls.length, 2);
    const regrade = graderCalls[1];
    assert.equal(regrade.hasOutput, true);
    assert.deepEqual(fileRoles(regrade.files), expectedScorerRoles);
    assert.equal(regrade.letterSha256, sha256(letterBytes));
    for (const file of regrade.files) {
      const manifest = f.subjects.get(report.subjectIds[0]).files;
      const { path, primary: _primary, ...identity } = file;
      assert.deepEqual(
        identity,
        manifest.find((entry) => entry.artifactId === file.artifactId),
      );
      const bytes = await readFile(path);
      assert.equal(bytes.byteLength, file.byteSize);
      assert.equal(sha256(bytes), file.sha256);
      // Downloaded by identity into the rescore's own files directory, not the run's copies.
      assert.ok(!graded.files.some((original) => original.path === path));
    }
    assert.equal(f.calls.downloads.length - downloadsBefore, 4);
    assert.ok(f.calls.downloads.slice(downloadsBefore).includes(completion.primaryArtifactId));
    const submitted = f.calls.results.slice(resultsBefore);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].state, "scored");
    assert.equal(submitted[0].scorerVersionId, graderVersion.id);
    assert.equal(submitted[0].sourceDigest, grader.definition.sourceDigest);
    assert.deepEqual(submitted[0].metrics, letterMetric);
    // Resuming reuses the verified copies and never downloads or scores again.
    const again = await rescore(options);
    f.assertClean();
    assert.deepEqual(again, regraded);
    assert.equal(f.calls.downloads.length - downloadsBefore, 4);
    assert.equal(graderCalls.length, 2);
    assert.equal(f.calls.results.length - resultsBefore, 1);
    console.log(
      "Installed rescore: frozen inputs and output downloaded by identity, graded once, resume reused them",
    );
  } finally {
    await hue.shutdown();
    await f.close();
  }

  // A declared file the target cannot deliver is the target's error, not an uncertain run.
  const negative = await fixture([version(builtins.exactMatch())]);
  const negativeHue = createHue({
    apiKey: key,
    baseUrl: negative.baseUrl,
    serviceName: "installed-missing-file",
    captureContent: false,
  });
  try {
    const report = await runExperiment({
      client: createEvaluationClient({ apiKey: key, baseUrl: negative.baseUrl }),
      hue: negativeHue,
      experimentId: negative.experiment.id,
      checkpointDirectory: checkpointDirectory(),
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
    negative.assertClean();
    assert.equal(report.subjectIds.length, 1);
    assert.equal(negative.calls.completions.length, 1);
    const completion = negative.calls.completions[0];
    assert.equal(completion.state, "error");
    assert.deepEqual(completion.output, { note: "claimed a file" });
    assert.deepEqual(completion.error, {
      type: "TargetError",
      message: "Generated file missing.docx could not be read",
    });
    assert.equal(Object.hasOwn(completion, "artifactIds"), false);
    assert.equal(Object.hasOwn(completion, "primaryArtifactId"), false);
    assert.equal(negative.calls.reserves.length, 0);
    assert.equal(negative.calls.uploads.length, 0);
    const subject = negative.subjects.get(report.subjectIds[0]);
    assert.equal(subject.executionState, "error");
    assert.deepEqual(subject.files.map((file) => file.role).sort(), [
      "attached_template",
      "org_template",
      "source",
    ]);
    assert.equal(negative.calls.results.length, 1);
    assert.equal(negative.calls.results[0].state, "skipped");
    console.log(
      "Installed undeliverable output file: saved as TargetError, no artifact reserved or uploaded",
    );
  } finally {
    await negativeHue.shutdown();
    await negative.close();
  }

  // A case pinned to a world: the worker declares environment-files:v1 and hands the agent its
  // agent-visible files with the world; the evaluator-only template stays with the grader.
  const world = await fixture([graderVersion], { world: true });
  /** One worker run against `f`, with its own telemetry client for that origin. */
  const worker = async (f, target) => {
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "installed-world-files",
      captureContent: false,
    });
    try {
      return await runLocalAgent({
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
        environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        checkpointDirectory: checkpointDirectory(),
        agent: {
          key: "letter-agent",
          name: "Letter agent",
          revision: "1",
          capabilities: [localAgentCapabilities.environmentFiles, "input:pdf", "input:docx"],
        },
        scorers: [grader],
        maxRuns: 1,
        target,
      });
    } finally {
      await hue.shutdown();
    }
  };
  try {
    const graderCallsBefore = graderCalls.length;
    const seen = {};
    await worker(world, async (_inputs, _tools, context) => {
      seen.context = context;
      seen.siblings = (await readdir(dirname(context.files[0].path))).sort();
      seen.modes = await Promise.all(
        context.files.map(async (file) => (await stat(file.path)).mode & 0o777),
      );
      const letter = join(context.outputDirectory, "Letter.docx");
      await writeFile(letter, letterBytes);
      return withFiles({ summary: "ok" }, [
        { path: letter, filename: letterName, contentType: docx, primary: true },
      ]);
    });
    world.assertClean();
    assert.deepEqual(world.calls.registrations[0].capabilities, [
      "environment-files:v1",
      "input:pdf",
      "input:docx",
      "environment:v1",
    ]);
    const { context } = seen;
    assert.equal(context.world.token, worldToken);
    assert.deepEqual(fileRoles(context.files), [
      ["attached_template", false],
      ["source", false],
    ]);
    for (const file of context.files) {
      const pinned = world.item.inputFiles.find((entry) => entry.artifactId === file.artifactId);
      const { path, ...identity } = file;
      assert.deepEqual(identity, pinned);
      assert.ok(!path.includes(worldToken));
    }
    assert.deepEqual(seen.modes, [0o600, 0o600]);
    // The agent's directory holds its two files and nothing of the evaluator's.
    assert.equal(seen.siblings.length, 2);
    assert.ok(!seen.siblings.some((name) => name.includes("Org.docx")));
    assert.deepEqual(world.calls.finishes, ["completed"]);
    const completion = world.calls.completions[0];
    assert.equal(completion.state, "succeeded");
    assert.deepEqual(completion.artifactIds, world.calls.uploads);
    assert.equal(completion.primaryArtifactId, world.calls.uploads[0]);
    assert.ok(
      Buffer.from(world.artifacts.get(completion.primaryArtifactId).bytes).equals(letterBytes),
    );
    assert.equal(world.calls.localRuns[0].state, "completed");
    assert.equal(graderCalls.length - graderCallsBefore, 1);
    assert.deepEqual(fileRoles(graderCalls.at(-1).files), expectedScorerRoles);
    // The case's files are removed once it is complete.
    assert.equal(existsSync(dirname(dirname(context.files[0].path))), false);
    assert.equal(existsSync(context.outputDirectory), false);
    console.log(
      "Installed world case with files: agent-visible files handed over with the world, letter linked, case files removed",
    );

    // Bytes that differ from the manifest are refused before any execution or world exists.
    const tampered = await fixture([graderVersion], { world: true, tamper: true });
    try {
      let targets = 0;
      await assert.rejects(
        worker(tampered, () => {
          targets++;
          return "unexpected";
        }),
        (error) =>
          error instanceof CaseFileError &&
          error.code === "case_file_mismatch" &&
          error.artifactId === tampered.inputs.source.id,
      );
      tampered.assertClean();
      assert.equal(targets, 0);
      assert.equal(tampered.calls.starts, 0);
      assert.equal(tampered.calls.worldCreates, 0);
      assert.equal(tampered.calls.completions.length, 0);
      console.log("Installed world case with altered bytes: refused as case_file_mismatch");
    } finally {
      await tampered.close();
    }

    // A name that is not one safe file name is refused before anything is downloaded.
    const traversal = await fixture([graderVersion], { world: true, sourceName: "../escape.pdf" });
    try {
      await assert.rejects(
        worker(traversal, () => "unexpected"),
        (error) => error instanceof CaseFileError && error.code === "case_file_name_refused",
      );
      traversal.assertClean();
      assert.deepEqual(traversal.calls.downloads, []);
      assert.equal(traversal.calls.starts, 0);
      assert.equal(traversal.calls.worldCreates, 0);
      console.log(
        "Installed world case with a traversal-like name: refused as case_file_name_refused",
      );
    } finally {
      await traversal.close();
    }
  } finally {
    await world.close();
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
