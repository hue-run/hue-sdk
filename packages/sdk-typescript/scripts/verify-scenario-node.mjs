import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  createConversionOutcomeScorer,
  conversionOutcomeScorerDefinition,
  createEvaluationClient,
  scoreLocally,
  sourceDigest,
} from "@hue-run/sdk/evals";
import { scoreConversionOutcome } from "@hue-run/sdk/evals/conversion-outcome-core.mjs";

const pin = "27d096eedc80fbfb747b849c891762f76165ef76429727b0a93ec7dbebaf7b05";
const source = await readFile(
  new URL(import.meta.resolve("@hue-run/sdk/evals/conversion-outcome-core.mjs")),
);
assert.equal(createHash("sha256").update(source).digest("hex"), pin);
assert.equal(sourceDigest(source), pin);
const scorer = createConversionOutcomeScorer();
assert.deepEqual(scorer.definition, conversionOutcomeScorerDefinition);
assert.equal(scorer.definition.sourceDigest, pin);
assert.equal(scorer.score, scoreConversionOutcome);
assert.equal(
  createRequire(import.meta.url)("@hue-run/sdk/evals/conversion-outcome-core.mjs")
    .scoreConversionOutcome,
  scorer.score,
);

const context = JSON.parse(
  await readFile(new URL("./tests/fixtures/scenario-outcome.json", import.meta.url)),
);
const direct = scorer.score(context);
assert.equal(direct.state, "scored");
assert.equal(direct.metrics.length, 7);
assert.ok(
  direct.metrics.every((metric) => metric.passed),
  "standalone draft and provider process criteria pass",
);

const id = "00000000-0000-4000-8000-000000000020";
let publications = 0;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, `/api/v1/scorers/${id}/versions`);
    assert.equal(request.headers.authorization, "Bearer synthetic-scorer-key");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.deepEqual(body, { definition: scorer.definition });
    publications++;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ id, contentDigest: "d".repeat(64), definition: body.definition }),
    );
  } catch {
    response.writeHead(400);
    response.end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const client = createEvaluationClient({
    apiKey: "synthetic-scorer-key",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });
  const version = await client.publishScorerVersion(id, scorer.definition);
  assert.equal(publications, 1);
  assert.deepEqual(await scoreLocally(version, context, { scorers: [scorer] }), direct);
  const changed = structuredClone(version);
  changed.definition.sourceDigest = "0".repeat(64);
  assert.deepEqual(await scoreLocally(changed, context, { scorers: [scorer] }), {
    state: "error",
    error: { type: "ScorerBindingUnavailable" },
  });
  for (const fault of ["reply_thread", "recipient", "subject", "process", "save", "unrelated"]) {
    const invalid = structuredClone(context);
    const message = invalid.environment.finalState.collections.messages.new;
    if (fault === "reply_thread") message.threadId = "existing";
    if (fault === "recipient") message.to = ["wrong@example.test"];
    if (fault === "subject") message.subject = "Re: Question";
    if (fault === "process") invalid.environment.steps[0].args.operation = "read";
    if (fault === "save") invalid.environment.steps[0].effects = [];
    if (fault === "unrelated") delete invalid.environment.finalState.collections.messages.parent;
    const result = await scoreLocally(version, invalid, { scorers: [scorer] });
    assert.equal(result.state, "scored", fault);
    assert.equal(
      result.metrics.find((metric) => metric.name === "task_success").passed,
      false,
      fault,
    );
  }
  console.log(
    JSON.stringify({
      runtime: process.version,
      installedScenarioScorer: "passed",
      sourceDigest: pin,
    }),
  );
} finally {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}
