import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createHue, HueExportError } from "@hue-run/sdk";
import { createChatAgent } from "./agent.js";

const mode = process.env.HUE_CHAT_MODE;
const capture = process.env.HUE_CAPTURE_CONTENT;
if (mode !== "synthetic" && mode !== "live")
  throw new Error("Choose HUE_CHAT_MODE=synthetic or live");
if (capture !== "true" && capture !== "false")
  throw new Error("Choose HUE_CAPTURE_CONTENT=true or false");
if (!process.env.HUE_API_KEY) throw new Error("Set HUE_API_KEY to a project service key");
if (mode === "live" && (!process.env.AI_GATEWAY_API_KEY || !process.env.HUE_CHAT_MODEL))
  throw new Error("Live mode requires AI_GATEWAY_API_KEY and HUE_CHAT_MODEL (provider/model)");
const hue = createHue({
  apiKey: process.env.HUE_API_KEY,
  baseUrl: process.env.HUE_BASE_URL,
  serviceName: "hue-reference-chatbot",
  captureContent: capture === "true",
  onExportIssue: (issue) => console.error(JSON.stringify({ telemetryIssue: issue })),
});
const project = await hue.checkConnection();
const html = await readFile(new URL("../public/index.html", import.meta.url));
const schema = z.object({
  sessionId: z.string().uuid(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }))
    .min(1)
    .max(40),
  mode: z.enum(["chat", "controlled-error"]).default("chat"),
});
async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 32768) throw new Error("Request body exceeds 32 KiB");
    chunks.push(chunk);
  }
  return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
function event(response: ServerResponse, name: string, data: unknown) {
  if (!response.destroyed) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
const port = Number(process.env.PORT ?? "3401");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
// This local example serves loopback browsers only. Comparing Origin with the
// client-supplied Host header alone is bypassable through DNS rebinding, so the
// Host header is allow-listed against the bound loopback address first.
function allowedHost(host: string | undefined, listeningPort: number): boolean {
  return host === `127.0.0.1:${listeningPort}` || host === `localhost:${listeningPort}`;
}
const server = createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  if (!allowedHost(request.headers.host, listeningPort)) {
    response.writeHead(403).end();
    return;
  }
  if (request.method === "GET" && request.url === "/") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
    return;
  }
  if (request.method === "GET" && request.url === "/config") {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        mode,
        captureContent: capture === "true",
        project: { id: project.id, name: project.name },
      }),
    );
    return;
  }
  if (request.method !== "POST" || request.url !== "/chat") {
    response.writeHead(404).end();
    return;
  }
  // Same-origin browser requests only; Host was allow-listed above.
  if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
    response.writeHead(403).end();
    return;
  }
  let input: z.infer<typeof schema>;
  try {
    input = await readRequest(request);
  } catch {
    response.writeHead(400).end("Invalid chat request");
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  const abort = new AbortController();
  response.on("close", () => abort.abort());
  let traceId: string | undefined;
  try {
    await hue.withSpan(
      "chat.request",
      async (span) => {
        traceId = span.traceId;
        event(response, "trace", { traceId, sessionId: input.sessionId });
        hue.recordMessages({ input: input.messages });
        if (input.mode === "controlled-error") {
          await hue.tool("controlledFailure", null, () => {
            throw new Error("Intentional reference-chatbot failure");
          });
          return;
        }
        const agent = createChatAgent(hue, input.messages, mode, process.env.HUE_CHAT_MODEL);
        const result = await agent.stream({ messages: input.messages, abortSignal: abort.signal });
        let text = "";
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            text += part.text;
            event(response, "text", { text: part.text });
          } else if (part.type === "tool-call") event(response, "tool", { name: part.toolName });
          else if (part.type === "tool-result")
            event(response, "tool-result", { name: part.toolName, output: part.output });
          else if (part.type === "error") throw part.error;
          else if (part.type === "abort") throw new Error("Chat request interrupted");
        }
        await result.text;
        span.setOutput(text);
        hue.recordMessages({ output: [{ role: "assistant", content: text }] });
      },
      {
        sessionId: input.sessionId,
        input: input.messages,
        attributes: { "hue.reference.mode": mode },
      },
    );
  } catch {
    event(response, "error", {
      message:
        input.mode === "controlled-error"
          ? "Intentional reference-chatbot failure recorded."
          : "The provider request failed or was interrupted. Inspect its trace for details.",
    });
  }
  try {
    const report = await hue.flush();
    event(response, "telemetry", { status: "accepted", report });
  } catch (error) {
    event(response, "telemetry", {
      status: "failed",
      ...(error instanceof HueExportError ? { issues: error.issues, report: error.report } : {}),
    });
  }
  event(response, "done", { traceId });
  response.end();
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(
    JSON.stringify({
      ready: true,
      url: `http://127.0.0.1:${typeof address === "object" ? address?.port : port}`,
      mode,
      captureContent: capture === "true",
      projectId: project.id,
    }),
  );
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  try {
    await hue.shutdown();
  } catch {
    process.exitCode = 1;
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
