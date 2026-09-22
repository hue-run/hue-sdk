import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

// Run from an installed standalone chatbot. Supply HUE_API_KEY/HUE_BASE_URL in the
// process environment; this script never writes or prints the key.
const cwd = resolve(process.argv[2] ?? ".");
const evidence = [];
for (const captureContent of ["true", "false"]) {
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd,
    env: {
      ...process.env,
      PORT: "0",
      HUE_CHAT_MODE: "synthetic",
      HUE_CAPTURE_CONTENT: captureContent,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const ready = await new Promise((resolveReady, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("Chatbot startup timed out")), 30000);
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("Chatbot exited before startup"));
      });
      child.stdout.on("data", (chunk) => {
        text += chunk;
        const line = text.split("\n").find((value) => value.startsWith('{"ready":'));
        if (line) {
          clearTimeout(timer);
          resolveReady(JSON.parse(line));
        }
      });
    });
    const config = await fetch(`${ready.url}/config`).then((response) => response.json());
    assert.equal(config.captureContent, captureContent === "true");
    assert.equal(config.mode, "synthetic");
    const sessionId = randomUUID();
    for (const mode of ["chat", "controlled-error"]) {
      const response = await fetch(`${ready.url}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          mode,
          messages: [
            { role: "user", content: "Count words in this synthetic integration request." },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      const events = body
        .trim()
        .split("\n\n")
        .map((frame) => ({
          name: frame.match(/^event: (.+)$/m)?.[1],
          data: JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? "{}"),
        }));
      const traceId = events.find((event) => event.name === "trace")?.data.traceId;
      assert.match(traceId, /^[0-9a-f]{32}$/u);
      const telemetry = events.find((event) => event.name === "telemetry")?.data;
      assert.equal(telemetry?.status, "accepted", "Collector rejected or failed telemetry");
      assert.equal(
        telemetry.report.failedSpans +
          telemetry.report.failedLogs +
          telemetry.report.rejectedSpans +
          telemetry.report.rejectedLogs,
        0,
      );
      assert.ok(telemetry.report.acceptedSpans > 0);
      assert.equal(telemetry.report.acceptedLogs > 0, captureContent === "true");
      if (mode === "chat") {
        assert.ok(
          events.some((event) => event.name === "tool" && event.data.name === "textStatistics"),
        );
        assert.ok(events.some((event) => event.name === "tool-result"));
        assert.ok(events.some((event) => event.name === "text"));
        assert.ok(!events.some((event) => event.name === "error"));
      } else assert.ok(events.some((event) => event.name === "error"));
      evidence.push({ captureContent, mode, traceId, sessionId, report: telemetry.report });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
  }
  assert.equal(stderr, "", "Chatbot wrote server or telemetry diagnostics");
}
console.log(JSON.stringify({ node: process.version, evidence }, null, 2));
