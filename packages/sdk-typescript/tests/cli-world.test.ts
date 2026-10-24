import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runWorldCommand, WORLD_USAGE, type WorldCommandIo } from "../src/cli/world.js";

// A synthetic stand-in for Hue written from the World creation contract (REST twin of
// `create_world`: POST /api/v1/world-creations, PUT to each signed URL, POST …/uploaded, GET
// …/:id) and the existing instance routes (POST /api/v1/instances, …/finish, …/evidence).
// Nothing leaves the loopback interface.

const cli = join(import.meta.dir, "../src/setup/cli.ts");
const KEY = "hue_sk_test_world_synthetic_key";
const TOKEN = "hue_world_synthetic_token_0123456789abcdef";
const CREATION = "6f9c1e2a-4b3d-4c5e-8f70-1a2b3c4d5e6f";
const VERSION = "0b7e3f5c-9d2a-4e1b-a6c8-7f9e0d1c2b3a";
const INSTANCE = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const stops: (() => void)[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Declared {
  app: string;
  files: { name?: string; byteSize: number; sha256: string }[];
}

/** A loopback Hue. `statuses` are the states each GET answers in turn after the uploads. */
function hue(
  options: {
    statuses?: string[];
    createStatus?: number;
    createBody?: Record<string, unknown>;
    report?: Record<string, unknown>;
    failCode?: string;
    evidenceConflicts?: number;
    putFailures?: number;
  } = {},
) {
  const creations: Record<string, unknown>[] = [];
  const stored = new Map<string, Buffer>();
  const putHeaders: Record<string, string>[] = [];
  const finishes: Record<string, unknown>[] = [];
  const requests: string[] = [];
  let declared: Declared[] = [];
  let polls = 0;
  let conflicts = options.evidenceConflicts ?? 0;
  let putFailures = options.putFailures ?? 0;
  const statuses = options.statuses ?? ["importing", "normalizing", "verifying", "ready"];
  const creation = (status: string) => ({
    id: CREATION,
    status,
    worldDefinitionId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
    worldVersionId: status === "ready" ? VERSION : null,
    url: `http://127.0.0.1:${server.port}/worlds/${CREATION}`,
    ...(status === "ready" || status === "failed"
      ? {
          report: options.report ?? {
            stored: 3,
            normalized: [{ label: "dates", detail: "Read dueDate as a date" }],
            standIns: [],
            notSimulated: ["Linear webhooks"],
            assumptions: ["Times are UTC"],
          },
        }
      : {}),
    ...(status === "failed" ? { errorCode: options.failCode ?? "records_invalid" } : {}),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname.startsWith("/upload/")) {
        expect(request.headers.get("authorization")).toBeNull();
        if (putFailures-- > 0) return new Response("busy", { status: 503 });
        putHeaders.push(Object.fromEntries(request.headers));
        stored.set(url.pathname.slice("/upload/".length), Buffer.from(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (request.headers.get("authorization") !== `Bearer ${KEY}`)
        return Response.json({ error: "Invalid project key" }, { status: 401 });
      if (url.pathname === "/api/v1/world-creations" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        creations.push(body);
        if (options.createStatus)
          return Response.json(options.createBody ?? {}, { status: options.createStatus });
        if (body.dryRun)
          return Response.json({
            outline: { linear: { teams: 2, issues: 40 } },
            estimate: { costUsd: 0.4, seconds: 90 },
          });
        const sources = (body.sources ?? {}) as { files?: Declared[] };
        declared = sources.files ?? [];
        const uploads = declared.flatMap((group) =>
          group.files.map((_, index) => ({
            app: group.app,
            file: index + 1,
            urlKey: `uploadUrl_${group.app}_${index + 1}`,
            method: "PUT",
            uploadHeaders: { "content-type": "application/json", "x-upload-check": "yes" },
          })),
        );
        return Response.json(
          {
            worldCreation: creation(declared.length ? "uploading" : "generating"),
            uploads,
            ...Object.fromEntries(
              uploads.map((upload) => [
                upload.urlKey,
                `http://127.0.0.1:${server.port}/upload/${upload.app}-${upload.file}?signature=secret-signature-value`,
              ]),
            ),
            next: declared.length ? "upload" : "get_world_creation",
          },
          { status: 201 },
        );
      }
      if (url.pathname === `/api/v1/world-creations/${CREATION}/uploaded`) {
        for (const group of declared)
          group.files.forEach((file, index) => {
            const bytes = stored.get(`${group.app}-${index + 1}`);
            expect(bytes?.byteLength).toBe(file.byteSize);
            expect(sha256(bytes!)).toBe(file.sha256);
          });
        return Response.json({ worldCreation: creation("importing") });
      }
      if (url.pathname === `/api/v1/world-creations/${CREATION}`) {
        const status = statuses[Math.min(polls++, statuses.length - 1)]!;
        return Response.json({ worldCreation: creation(status) });
      }
      if (url.pathname === "/api/v1/instances" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.environmentVersionId !== VERSION)
          return Response.json({ error: "Not found" }, { status: 404 });
        const base = `http://127.0.0.1:${server.port}/sim`;
        return Response.json(
          {
            id: INSTANCE,
            environmentVersionId: VERSION,
            clockNs: "0",
            stateDigest: "sha256:0",
            maxSteps: 500,
            expiresAt: "2026-10-24T13:00:00.000Z",
            actions: [],
            worldId: INSTANCE,
            token: TOKEN,
            lifecycle: "live",
            completingUntil: null,
            baggage: `hue-world=${INSTANCE}`,
            traceparent: null,
            now: "2026-03-02T09:00:00.000Z",
            surfaces: [{ id: "linear/graphql", url: `${base}/linear/graphql` }],
            env: {
              HUE_WORLD_ID: INSTANCE,
              HUE_WORLD_TOKEN: TOKEN,
              HUE_WORLD_NOW: "2026-03-02T09:00:00.000Z",
              HUE_SIM_LINEAR_GRAPHQL_URL: `${base}/linear/graphql`,
            },
            mcpConfig: {
              mcpServers: {
                linear: {
                  type: "http",
                  url: `${base}/linear/mcp`,
                  headers: { Authorization: `Bearer ${TOKEN}` },
                },
              },
            },
          },
          { status: 201 },
        );
      }
      if (url.pathname === `/api/v1/instances/${INSTANCE}/finish`) {
        const body = (await request.json()) as Record<string, unknown>;
        finishes.push(body);
        return Response.json({
          id: INSTANCE,
          status: body.status,
          stepCount: 3,
          stateDigest: "sha256:1",
          sealedAt: null,
          lifecycle: "completing",
          completingUntil: new Date(Date.now() - 1000).toISOString(),
        });
      }
      if (url.pathname === `/api/v1/instances/${INSTANCE}/evidence`) {
        if (conflicts-- > 0)
          return Response.json({ error: "World evidence is unavailable" }, { status: 409 });
        const coverage = {
          validity: "environment_incomplete",
          firstGap: {
            provider: "linear",
            operation: "customerNeeds",
            code: "unimplemented",
            description: "Customer needs are not simulated",
          },
        };
        const call = (seq: number, operation: string, classification: string) => ({
          seq,
          surface: "linear/graphql",
          operation,
          classification,
          gap: null,
          request: null,
          response: null,
        });
        if (url.searchParams.get("section") === "ledger") {
          expect(url.searchParams.get("bodies")).toBe("false");
          return Response.json({
            world: { id: INSTANCE },
            coverage,
            ledger: {
              items: [
                call(0, "issues", "ok"),
                call(1, "issues", "ok"),
                call(2, "issueUpdate", "ok"),
                call(3, "customerNeeds", "unimplemented"),
              ],
              nextCursor: null,
            },
          });
        }
        return Response.json({
          world: { id: INSTANCE },
          coverage,
          diff: {
            items: [
              {
                ref: { collection: "issues", id: "issue-1" },
                change: "updated",
                before: {},
                after: {},
                changedFields: ["/stateId", "/updatedAt"],
                steps: [2],
              },
            ],
          },
        });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  stops.push(() => void server.stop(true));
  return {
    origin: `http://127.0.0.1:${server.port}`,
    creations,
    stored,
    putHeaders,
    finishes,
    requests,
  };
}

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-world-"));
  directories.push(directory);
  return directory;
}

async function world(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; io?: Partial<WorldCommandIo> } = {},
): Promise<{ code: number; stdout: string; stderr: string; sleeps: number[] }> {
  let stdout = "";
  let stderr = "";
  const sleeps: number[] = [];
  const code = await runWorldCommand(args, {
    stdout: new Writable({
      write: (chunk, _encoding, done) => ((stdout += String(chunk)), done()),
    }),
    stderr: new Writable({
      write: (chunk, _encoding, done) => ((stderr += String(chunk)), done()),
    }),
    env: { PATH: process.env.PATH ?? "", HUE_API_KEY: KEY, ...options.env },
    cwd: options.cwd ?? (await scratch()),
    sleep: async (ms) => void sleeps.push(ms),
    onInterrupt: () => () => {},
    ...options.io,
  });
  return { code, stdout, stderr, sleeps };
}

describe("hue world create", () => {
  test("uploads each app's files exactly, marks them uploaded and prints the ready World", async () => {
    const stand = hue();
    const dir = await scratch();
    await mkdir(join(dir, "data", "linear", "more"), { recursive: true });
    await mkdir(join(dir, "data", "slack"), { recursive: true });
    const issues = Buffer.from('[{"__typename":"Issue","id":"i1","title":"Ship it"}]\n');
    const nested = Buffer.from('{"kind":"export","bytes":[1,2,3]}');
    const slack = Buffer.from("channel,text\ngeneral,hello\n");
    await writeFile(join(dir, "data", "linear", "issues.json"), issues);
    await writeFile(join(dir, "data", "linear", "more", "teams.json"), nested);
    await writeFile(join(dir, "data", "slack", "messages.csv"), slack);
    await writeFile(join(dir, "data", "slack", ".DS_Store"), "hidden");

    const result = await world(
      [
        "create",
        "--apps",
        "linear,slack",
        "--name",
        "Acme support",
        "--files",
        "data",
        "--describe",
        "A support team triaging bugs",
        "--origin",
        stand.origin,
      ],
      { cwd: dir },
    );

    expect(result.stderr).toContain("Status: importing");
    expect(result.code).toBe(0);
    const body = stand.creations[0]!;
    expect(body.name).toBe("Acme support");
    expect(body.apps).toEqual([{ app: "linear" }, { app: "slack" }]);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.sources).toEqual({
      files: [
        {
          app: "linear",
          files: [
            { name: "issues.json", byteSize: issues.byteLength, sha256: sha256(issues) },
            { name: "more/teams.json", byteSize: nested.byteLength, sha256: sha256(nested) },
          ],
        },
        {
          app: "slack",
          files: [{ name: "messages.csv", byteSize: slack.byteLength, sha256: sha256(slack) }],
        },
      ],
      description: { text: "A support team triaging bugs" },
    });
    expect(stand.stored.get("linear-1")).toEqual(issues);
    expect(stand.stored.get("linear-2")).toEqual(nested);
    expect(stand.stored.get("slack-1")).toEqual(slack);
    expect(stand.putHeaders[0]!["x-upload-check"]).toBe("yes");
    expect(result.stdout).toBe(
      [
        `World: ${stand.origin}/worlds/${CREATION}`,
        `World version: ${VERSION}`,
        "Stored: 3",
        "Normalized: 1",
        "  label dates, detail Read dueDate as a date",
        "Stand-ins: none",
        "Not simulated: 1",
        "  Linear webhooks",
        "Assumptions: 1",
        "  Times are UTC",
        `Run your agent in it: hue world run ${VERSION} -- <command>`,
        "",
      ].join("\n"),
    );
    // The signed URLs are capabilities: never printed.
    expect(result.stdout + result.stderr).not.toContain("secret-signature-value");
    expect(result.stdout + result.stderr).not.toContain(KEY);
    expect(stand.requests.filter((line) => line.startsWith("POST"))).toEqual([
      "POST /api/v1/world-creations",
      `POST /api/v1/world-creations/${CREATION}/uploaded`,
    ]);
  });

  test("creates a World from a description alone, and previews one with --dry-run", async () => {
    const stand = hue({ statuses: ["generating", "ready"] });
    const preview = await world([
      "create",
      "--apps",
      "linear",
      "--describe",
      "A ten-person startup",
      "--dry-run",
      "--origin",
      stand.origin,
    ]);
    expect(preview.code).toBe(0);
    expect(stand.creations[0]).toMatchObject({ dryRun: true, name: "linear" });
    expect(preview.stdout).toContain("Dry run: Hue created nothing.");
    expect(preview.stdout).toContain("Estimate: costUsd 0.4, seconds 90");
    expect(preview.stdout).toContain('"issues": 40');

    const created = await world([
      "create",
      "--apps",
      "linear",
      "--describe",
      "A ten-person startup",
      "--origin",
      stand.origin,
    ]);
    expect(created.code).toBe(0);
    expect(stand.creations[1]!.sources).toEqual({ description: { text: "A ten-person startup" } });
    expect(stand.requests).not.toContain(`POST /api/v1/world-creations/${CREATION}/uploaded`);
    expect(created.stdout).toContain(`World version: ${VERSION}`);
  });

  test("retries a busy upload and exits 1 with the error code of a failed World", async () => {
    const stand = hue({ statuses: ["importing", "failed"], putFailures: 1 });
    const dir = await scratch();
    await writeFile(join(dir, "records.json"), "[]");
    const result = await world(
      ["create", "--apps", "linear", "--files", ".", "--origin", stand.origin],
      { cwd: dir },
    );
    expect(result.code).toBe(1);
    expect(stand.stored.get("linear-1")?.toString()).toBe("[]");
    expect(result.sleeps).toContain(1000);
    expect(result.stderr).toContain("World creation failed: records_invalid.");
  });

  test("stops waiting at --wait and names where to follow the World", async () => {
    const stand = hue({ statuses: ["generating"] });
    const result = await world([
      "create",
      "--apps",
      "linear",
      "--describe",
      "A design agency",
      "--wait",
      "0",
      "--origin",
      stand.origin,
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      `The World is not ready yet (generating); follow it at ${stand.origin}/worlds/${CREATION}.`,
    );
  });

  test("prints Hue's refusal with each invalid field", async () => {
    const stand = hue({
      createStatus: 400,
      createBody: {
        error: "Invalid request",
        issues: [{ path: ["apps", 0, "app"], message: "Unknown app: lineer" }],
      },
    });
    const result = await world(["create", "--apps", "lineer", "--origin", stand.origin]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Error: Hue refused the request (HTTP 400, Invalid request).\n  apps.0.app: Unknown app: lineer",
    );
  });

  test("refuses usage errors before calling Hue", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "data", "misc"), { recursive: true });
    await writeFile(join(dir, "data", "misc", "a.json"), "[]");
    const cases: [string[], string][] = [
      [["create"], "--apps is required"],
      [["create", "--apps", "Linear"], "not an app id"],
      [["create", "--apps", "linear,slack", "--files", "data"], "data/misc/a.json"],
      [["create", "--apps", "linear", "--wait", "soon"], "--wait must be a whole number"],
      [["run"], "Name the World version"],
      [["run", "not-a-version", "--", "true"], "not a World version id"],
      [["run", VERSION], "Name the command to run after --"],
      [["fly"], "Unknown command: hue world fly"],
    ];
    for (const [args, message] of cases) {
      const result = await world([...args, "--origin", "http://127.0.0.1:9"], { cwd: dir });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain(WORLD_USAGE);
    }
    const keyless = await world(["create", "--apps", "linear"], { env: { HUE_API_KEY: "" } });
    expect(keyless.code).toBe(2);
    expect(keyless.stderr).toContain("HUE_API_KEY is required");
  });
});

/** A command that records what it was given: its arguments, environment and MCP configuration. */
async function recorder(exitCode: number): Promise<string[]> {
  const script = join(await scratch(), "record.cjs");
  await writeFile(
    script,
    `const fs = require("node:fs");
const env = process.env;
fs.writeFileSync(env.RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  env,
  mcp: JSON.parse(fs.readFileSync(env.HUE_MCP_CONFIG, "utf8")),
  mode: (fs.statSync(env.HUE_MCP_CONFIG).mode & 0o777).toString(8),
}));
process.exit(${exitCode});
`,
  );
  return [process.execPath, script];
}

describe("hue world run", () => {
  test("runs the command with the instance's environment, finishes it and prints its evidence", async () => {
    const stand = hue({ evidenceConflicts: 1 });
    const dir = await scratch();
    const record = join(dir, "record.json");
    const result = await world(
      ["run", VERSION, "--origin", stand.origin, "--", ...(await recorder(0)), "--flag"],
      {
        env: { RECORD: record, HUE_MCP_KEY: "hue_mcp_project_key_value", OPENAI_API_KEY: "sk-own" },
      },
    );

    expect(result.code).toBe(0);
    const seen = JSON.parse(await readFile(record, "utf8")) as {
      argv: string[];
      env: Record<string, string>;
      mcp: unknown;
      mode: string;
    };
    expect(seen.argv).toEqual(["--flag"]);
    expect(seen.env.HUE_WORLD_TOKEN).toBe(TOKEN);
    expect(seen.env.HUE_WORLD_NOW).toBe("2026-03-02T09:00:00.000Z");
    expect(seen.env.HUE_SIM_LINEAR_GRAPHQL_URL).toBe(`${stand.origin}/sim/linear/graphql`);
    expect(seen.env.OPENAI_API_KEY).toBe("sk-own");
    expect(seen.env.HUE_API_KEY).toBeUndefined();
    expect(seen.env.HUE_MCP_KEY).toBeUndefined();
    expect(seen.mcp).toEqual({
      mcpServers: {
        linear: {
          type: "http",
          url: `${stand.origin}/sim/linear/mcp`,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    });
    expect(seen.mode).toBe("600");
    expect(existsSync(seen.env.HUE_MCP_CONFIG!)).toBe(false);
    expect(stand.finishes).toEqual([{ idempotencyKey: expect.any(String), status: "completed" }]);
    expect(result.stderr).toContain(
      `The command exited with code 0; instance ${INSTANCE} completed.`,
    );
    expect(result.stderr).toContain(
      [
        "Calls: 4",
        "  2 × linear/graphql issues (ok)",
        "  1 × linear/graphql issueUpdate (ok)",
        "  1 × linear/graphql customerNeeds (unimplemented)",
        "Writes: 1",
        "  updated issues issue-1 (/stateId, /updatedAt)",
        "Coverage gaps: 2",
        "  1 × linear/graphql customerNeeds (unimplemented)",
        "  reported: linear customerNeeds (unimplemented)",
      ].join("\n"),
    );
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  test("abandons the instance and exits with the command's code when it fails", async () => {
    const stand = hue();
    const dir = await scratch();
    const result = await world(
      ["run", VERSION, "--origin", stand.origin, "--", ...(await recorder(3))],
      {
        env: { RECORD: join(dir, "record.json") },
      },
    );
    expect(result.code).toBe(3);
    expect(stand.finishes[0]!.status).toBe("abandoned");
  });

  test("passes a stop request on to the command, kills it on a later one and still reports", async () => {
    const stand = hue();
    let stop: ((signal: NodeJS.Signals) => void) | undefined;
    // The command ignores SIGTERM, so only the second request, a second later, ends it.
    const command = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
    const pending = world(
      ["run", VERSION, "--origin", stand.origin, "--", process.execPath, "-e", command],
      { io: { onInterrupt: (listener) => ((stop = listener), () => {}) } },
    );
    while (!stand.requests.includes("POST /api/v1/instances")) await Bun.sleep(20);
    await Bun.sleep(300);
    stop!("SIGTERM");
    stop!("SIGTERM"); // the same request, forwarded twice by npx: ignored
    await Bun.sleep(1100);
    expect(stand.finishes).toEqual([]);
    stop!("SIGTERM");
    const result = await pending;
    expect(result.code).toBe(137);
    expect(stand.finishes[0]!.status).toBe("abandoned");
    expect(result.stderr).toContain("Calls: 4");
  });

  test("names a World version the project does not have", async () => {
    const stand = hue();
    const missing = "11111111-2222-4333-8444-555555555555";
    const result = await world(["run", missing, "--origin", stand.origin, "--", "true"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Error: This project has no World version ${missing} (HTTP 404)`,
    );
  });
});

describe("the hue binary", () => {
  test("routes hue world to the World command", async () => {
    const child = spawn(process.execPath, [cli, "world", "--help"], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    const code = await new Promise<number | null>((done) => child.on("close", done));
    expect(code).toBe(0);
    expect(stdout).toBe(`${WORLD_USAGE}\n`);
  });
});
