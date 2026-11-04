import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EvalInvocation, EvalGateReceipt } from "../evals/invocations.js";
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
export interface EvalReport {
  schemaVersion: 1;
  invocationId: string | null;
  runId: string | null;
  runUrl: string | null;
  verdict: EvalGateReceipt["verdict"] | null;
  receipt: EvalInvocation["receipt"];
  category: EvalReportCategory;
  errors: { code: string; message: string }[];
  exitCode: number;
}
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
    category:
      verdict === "pass"
        ? "pass"
        : verdict === "fail"
          ? "quality_failure"
          : verdict === "error"
            ? "agent_error"
            : verdict === "cancelled"
              ? "cancelled"
              : "incomplete",
    errors: [],
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
export async function writeEvalReports(directory: string, report: EvalReport): Promise<string> {
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
  const rows = result?.results ?? [];
  const details = [...report.errors.map((error) => error.message), ...(result?.reasons ?? [])].join(
    "; ",
  );
  // The gate test retains aggregate policy failures even if every individual result is scored.
  const failed = report.exitCode !== 0;
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Hue / Evals" tests="${rows.length + 1}" failures="${failed ? 1 : 0}"><testcase name="Hue gate">${failed ? `<failure type="${xml(report.category)}" message="${xml(details || report.category)}"/>` : ""}</testcase>${rows.map((row) => `<testcase classname="${xml(row.caseId)}" name="${xml(row.evaluatorVersionId)}"><system-out>${xml(JSON.stringify({ state: row.state, metrics: row.metrics }))}</system-out></testcase>`).join("")}</testsuite>\n`;
  const summary = `# Hue / Evals\n\n${markdown(report.verdict ?? "No gate receipt")} (${report.category})\n\n${report.runUrl ? `Run: ${markdown(report.runUrl)}\n\n` : ""}${details ? `${markdown(details)}\n\n` : ""}Exit code: ${report.exitCode}\n`;
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
  return serialized;
}
