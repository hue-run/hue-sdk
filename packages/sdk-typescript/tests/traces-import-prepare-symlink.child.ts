import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareTraceBundle } from "../src/cli/traces-import-prepare.js";
import { Progress } from "../src/cli/traces-import-upload.js";

const action = process.env.HUE_RACE_ACTION ?? "";
const root = process.env.HUE_RACE_ROOT ?? "";
const output = process.env.HUE_RACE_OUTPUT ?? "";
const marker = process.env.HUE_RACE_MARKER ?? "";
const resultPath = process.env.HUE_RACE_RESULT ?? "";

function traceExport(prompt: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "chatbot" } }],
        },
        scopeSpans: [
          {
            scope: { name: "synthetic", version: "1" },
            spans: [
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "b7ad6b7169203331",
                name: "chat",
                kind: 1,
                startTimeUnixNano: "1760000000000000000",
                endTimeUnixNano: "1760000002000000000",
                attributes: [{ key: "gen_ai.prompt", value: { stringValue: prompt } }],
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  });
}

let threw: string | null = null;
try {
  await mkdir(output, { mode: 0o700 });
  if (action === "progress") {
    const progress = new Progress(
      join(output, "progress.json"),
      {
        version: 1,
        manifest_digest: marker,
        import_url: "http://127.0.0.1/api/v1/trace-imports/00000000-0000-4000-8000-000000000001",
        traces: {},
      },
      0,
    );
    await progress.changed();
    threw = progress.failure?.message ?? null;
  } else {
    const input = join(root, "traces.json");
    await writeFile(input, traceExport(marker));
    await prepareTraceBundle(input, { out: output });
  }
} catch (error) {
  threw = error instanceof Error ? error.message : String(error);
}

await writeFile(resultPath, JSON.stringify({ threw }));
