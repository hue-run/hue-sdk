import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHue } from "@hue-run/sdk";
import { z } from "zod";

const messageSchema = z.object({ id: z.string().min(1) });
const listSchema = z.object({ messages: z.array(messageSchema).default([]) });
type Gmail = { baseUrl: string; accessToken: string; maxResults?: number };

// This helper returns a summary, as an ordinary agent tool would.
export async function summarizeInbox(gmail: Gmail) {
  async function get(path: string) {
    const response = await fetch(`${gmail.baseUrl}/gmail/v1/users/me/${path}`, {
      headers: { Authorization: `Bearer ${gmail.accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Gmail request failed with HTTP ${response.status}`);
    return response.json();
  }
  const page = listSchema.parse(
    await get(`messages?maxResults=${gmail.maxResults ?? 5}&q=is%3Aunread`),
  );
  const ids: string[] = [];
  for (const message of page.messages.slice(0, 5)) {
    const full = messageSchema.parse(
      await get(`messages/${encodeURIComponent(message.id)}?format=full`),
    );
    ids.push(full.id);
  }
  return { count: ids.length, ids };
}

export async function runSummary(hue: ReturnType<typeof createHue>, gmail: Gmail) {
  return hue.withSpan("inbox.request", async (span) => {
    span.setInput({ task: "Summarize up to five unread messages" });
    const summary = await hue.tool(
      "summarize_inbox",
      { maxResults: gmail.maxResults ?? 5, q: "is:unread" },
      () => summarizeInbox(gmail),
    );
    span.setOutput(summary);
    return { summary, traceId: span.traceId };
  });
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false") throw new Error(`Set ${name}=true or false`);
  return value === "true";
}

async function runLive() {
  if (process.argv[2] !== "--live")
    throw new Error("Use npm run offline, or npm start for live Gmail reads");
  const apiKey = process.env.HUE_API_KEY;
  const accessToken = process.env.GMAIL_ACCESS_TOKEN;
  if (!apiKey || !accessToken)
    throw new Error("Live mode requires HUE_API_KEY and GMAIL_ACCESS_TOKEN");
  const captureContent = envBoolean("HUE_CAPTURE_CONTENT", true);
  // Environment names are this application's convention; Hue reads no env files.
  const hue = createHue({
    apiKey,
    baseUrl: process.env.HUE_BASE_URL,
    serviceName: "gmail-summary-tool",
    captureContent,
    captureHttp: envBoolean("HUE_CAPTURE_HTTP", true),
    captureHttpBodies: envBoolean("HUE_CAPTURE_HTTP_BODIES", captureContent),
  });
  try {
    const { summary, traceId } = await runSummary(hue, {
      baseUrl: "https://gmail.googleapis.com",
      accessToken,
    });
    await hue.flush();
    console.log(JSON.stringify({ mode: "live", count: summary.count, traceId, exported: true }));
  } finally {
    await hue.shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runLive();
  } catch {
    console.error(
      "Gmail summary failed. Check credentials, capture options and telemetry delivery.",
    );
    process.exitCode = 1;
  }
}
