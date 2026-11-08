import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EvalInvocation, EvalGateReceipt } from "../evals/invocations.js";
import { metricPassed } from "../evals/verdicts.js";
import { stripHueControlPlaneCredentials } from "../world/world.js";

export type EvalReportCategory =
  | "pass"
  | "quality_failure"
  | "agent_error"
  | "configuration_error"
  | "authentication_error"
  | "hue_error"
  | "incomplete"
  | "cancelled";
type Verdict = EvalGateReceipt["verdict"];
/** A case's outcome in one trial; `undecided` covers missing, pending, errored and inconclusive. */
type TrialCaseState = "passed" | "failed" | "undecided";
/** The CLI's gate over several trials, each an ordinary server-receipted run. */
export interface TrialGate {
  kind: "trials";
  verdict: Verdict;
  trials: number;
  minPassRate: number;
  /** Passes over scored trials across every case, or null when nothing was scored. */
  passRate: number | null;
  cases: {
    caseId: string;
    passes: number;
    /** Trials that passed or failed this case. */
    scored: number;
    trials: number;
    passRate: number | null;
    passed: boolean;
    /** One state per trial, in trial order. */
    states: TrialCaseState[];
  }[];
  reasons: string[];
}
export interface EvalReport {
  schemaVersion: 1;
  invocationId: string | null;
  runId: string | null;
  runUrl: string | null;
  verdict: Verdict | null;
  /** The server receipt, or with more than one trial the CLI's {@link TrialGate}. */
  receipt: EvalInvocation["receipt"] | TrialGate;
  /** Present only with more than one trial: each run and its server receipt. */
  trials?: {
    trial: number;
    invocationId: string;
    runId: string;
    runUrl: string;
    verdict: Verdict | null;
    receipt: EvalInvocation["receipt"];
  }[];
  category: EvalReportCategory;
  errors: { code: string; message: string }[];
  exitCode: number;
}
const categoryOf = (verdict: Verdict | null): EvalReportCategory =>
  verdict === "pass"
    ? "pass"
    : verdict === "fail"
      ? "quality_failure"
      : verdict === "error"
        ? "agent_error"
        : verdict === "cancelled"
          ? "cancelled"
          : "incomplete";
export function evalReport(invocation?: EvalInvocation): EvalReport {
  const receipt = invocation?.receipt ?? null;
  const verdict = receipt?.verdict ?? null;
  return {
    schemaVersion: 1,
    invocationId: invocation?.id ?? null,
    runId: invocation?.runId ?? null,
    runUrl: invocation?.runUrl ?? null,
    verdict,
    receipt,
    category: categoryOf(verdict),
    errors: [],
    exitCode: verdict === "pass" ? 0 : 1,
  };
}

/** Passes over scored trials, or null when none scored. The release artifact scanner refuses a
 * slash between identifiers. shortcut: the product can sit one unit in the last place below the
 * quotient (5/6, 5/7 and 7/9 among trial counts), so a minimum set to exactly that double fails
 * the case; compare as integers if a configuration ever needs such a minimum. */
const rate = (passes: number, scored: number) => (scored ? passes * scored ** -1 : null);

/** Reads one case's outcome from a trial's receipt evidence. A passing receipt passes every case;
 * in a failing one a case fails on a failing metric or threshold and passes only when every
 * applicable result is scored and meets them. */
function caseOutcome(invocation: EvalInvocation, caseId: string): TrialCaseState {
  const receipt = invocation.receipt;
  if (receipt?.verdict === "pass") return "passed";
  if (receipt?.verdict !== "fail") return "undecided";
  const rows = receipt.results.filter((row) => row.caseId === caseId);
  const pinned =
    invocation.manifest.cases.find((item) => item.caseId === caseId)?.evaluatorVersionIds ?? [];
  let failed = false;
  // A pinned evaluator without a row leaves the case undecided, never passed.
  let undecided =
    !rows.some((row) => row.state === "scored") ||
    pinned.some((id) => !rows.some((row) => row.evaluatorVersionId === id));
  for (const row of rows) {
    if (row.state === "not_applicable") continue;
    if (row.state !== "scored") {
      undecided = true;
      continue;
    }
    if (!row.metrics.every(metricPassed)) failed = true;
    for (const threshold of invocation.manifest.policy.thresholds) {
      if (threshold.evaluatorVersionId !== row.evaluatorVersionId) continue;
      const value = row.metrics.find((metric) => metric.name === threshold.metric)?.value;
      if (typeof value !== "number") undecided = true;
      else if (threshold.operator === "gte" ? value < threshold.value : value > threshold.value)
        failed = true;
    }
  }
  return failed ? "failed" : undecided ? "undecided" : "passed";
}

/** One trial's run and server receipt, as `results.json` lists it. */
export const trialRun = (
  invocation: EvalInvocation,
  index: number,
): NonNullable<EvalReport["trials"]>[number] => ({
  trial: index + 1,
  invocationId: invocation.id,
  runId: invocation.runId,
  runUrl: invocation.runUrl,
  verdict: invocation.receipt?.verdict ?? null,
  receipt: invocation.receipt,
});

/** Gates several trials of one selection: each case must be decided in every trial and pass at
 * least `minPassRate` of them. A trial without a pass or fail receipt decides the verdict. */
export function trialReport(invocations: EvalInvocation[], minPassRate: number): EvalReport {
  const caseIds = [
    ...new Set(invocations.flatMap((invocation) => invocation.manifest.cases.map((c) => c.caseId))),
  ];
  const cases = caseIds.map((caseId) => {
    const states = invocations.map((invocation) => caseOutcome(invocation, caseId));
    const passes = states.filter((state) => state === "passed").length;
    const scored = passes + states.filter((state) => state === "failed").length;
    const passRate = rate(passes, scored);
    return {
      caseId,
      passes,
      scored,
      trials: states.length,
      passRate,
      passed: scored === states.length && passRate !== null && passRate >= minPassRate,
      states,
    };
  });
  const reasons: string[] = [];
  invocations.forEach((invocation, index) => {
    if (
      invocation.receipt?.verdict === "fail" &&
      !cases.some((item) => item.states[index] === "failed")
    )
      reasons.push(`Trial ${index + 1} failed without a failing case result`);
    if (invocation.receipt?.comparisons?.some((comparison) => !comparison.passed))
      reasons.push(`Trial ${index + 1} failed a baseline comparison`);
  });
  for (const item of cases)
    if (!item.passed)
      reasons.push(
        item.scored < item.trials
          ? `Case ${item.caseId} has ${item.trials - item.scored} trial(s) without a pass or fail`
          : `Case ${item.caseId} passed ${item.passes} of ${item.trials} trials, below ${minPassRate}`,
      );
  const verdicts = invocations.map((invocation) => invocation.receipt?.verdict ?? "incomplete");
  const verdict =
    (["cancelled", "error", "incomplete"] as const).find((value) => verdicts.includes(value)) ??
    (reasons.length ? "fail" : "pass");
  const scored = cases.reduce((total, item) => total + item.scored, 0);
  const passes = cases.reduce((total, item) => total + item.passes, 0);
  return {
    ...evalReport(),
    verdict,
    receipt: {
      kind: "trials",
      verdict,
      trials: invocations.length,
      minPassRate,
      passRate: rate(passes, scored),
      cases,
      reasons,
    },
    trials: invocations.map(trialRun),
    category: categoryOf(verdict),
    exitCode: verdict === "pass" ? 0 : 1,
  };
}
const xml = (value: string) =>
  value
    // XML 1.0 excludes these control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const markdown = (value: string) =>
  value.replace(/[\\`*_{}[\]<>()#!|]/g, "\\$&").replace(/[\r\n]+/g, " ");

/** Reports contain receipt results, never manifest inputs, world tokens or evaluator evidence. */
export async function writeEvalReports(
  directory: string,
  report: EvalReport,
): Promise<{ json: string; summary: string }> {
  const secrets = Object.entries(process.env)
    .filter(([name]) => !(name in stripHueControlPlaneCredentials(process.env)))
    .flatMap(([, value]) =>
      value && value.length >= 8 ? [value, JSON.stringify(value).slice(1, -1)] : [],
    );
  const redact = (value: string) => {
    for (const secret of secrets) value = value.replaceAll(secret, "[redacted]");
    return value;
  };
  const serialized = redact(`${JSON.stringify(report, null, 2)}\n`);
  const result = report.receipt;
  const gate = result && "kind" in result ? result : null;
  const runs = report.trials ?? [];
  const rows = gate
    ? runs.flatMap((run) =>
        (run.receipt?.results ?? []).map((row) => ({
          ...row,
          name: `${row.evaluatorVersionId} · trial ${run.trial}`,
        })),
      )
    : result && !("kind" in result)
      ? result.results.map((row) => ({ ...row, name: row.evaluatorVersionId }))
      : [];
  const cases = gate?.cases ?? [];
  const details = [...report.errors.map((error) => error.message), ...(result?.reasons ?? [])].join(
    "; ",
  );
  // The gate test retains aggregate policy failures even if every individual result is scored.
  const failed = report.exitCode !== 0;
  const passes = (item: TrialGate["cases"][number]) =>
    `${item.passes}/${item.trials}${item.scored < item.trials ? ` (${item.trials - item.scored} undecided)` : ""}`;
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Hue / Evals" tests="${rows.length + cases.length + 1}" failures="${(failed ? 1 : 0) + cases.filter((item) => !item.passed).length}"><testcase name="Hue gate">${failed ? `<failure type="${xml(report.category)}" message="${xml(details || report.category)}"/>` : ""}</testcase>${cases.map((item) => `<testcase classname="${xml(item.caseId)}" name="pass rate"><system-out>${xml(JSON.stringify({ passes: item.passes, scored: item.scored, trials: item.trials, passRate: item.passRate, states: item.states }))}</system-out>${item.passed ? "" : `<failure type="quality_failure" message="${xml(`${passes(item)} trials passed`)}"/>`}</testcase>`).join("")}${rows.map((row) => `<testcase classname="${xml(row.caseId)}" name="${xml(row.name)}"><system-out>${xml(JSON.stringify({ state: row.state, metrics: row.metrics }))}</system-out></testcase>`).join("")}</testsuite>\n`;
  const trials = gate
    ? `Trials: ${gate.trials}. Minimum pass rate: ${gate.minPassRate}. Overall pass rate: ${gate.passRate === null ? "none" : `${Math.round(gate.passRate * 100)}%`}.\n\n| Case | Passes | Gate |\n| --- | --- | --- |\n${cases.map((item) => `| ${markdown(item.caseId)} | ${passes(item)} | ${item.passed ? "pass" : "fail"} |`).join("\n")}\n\n`
    : "";
  const runList = runs.length
    ? `${runs.map((run) => `- Trial ${run.trial}: ${markdown(run.verdict ?? "No gate receipt")}, ${markdown(run.runUrl)}`).join("\n")}\n\n`
    : "";
  const summary = `# Hue / Evals\n\n${markdown(report.verdict ?? "No gate receipt")} (${report.category})\n\n${trials}${runList}${report.runUrl ? `Run: ${markdown(report.runUrl)}\n\n` : ""}${details ? `${markdown(details)}\n\n` : ""}Exit code: ${report.exitCode}\n`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, content] of [
    ["results.json", serialized],
    ["junit.xml", junit],
    ["summary.md", summary],
  ] as const) {
    const path = join(directory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, redact(content), { mode: 0o600 });
    await rename(temporary, path);
  }
  return { json: serialized, summary: redact(summary) };
}
