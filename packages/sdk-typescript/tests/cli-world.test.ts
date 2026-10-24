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
    /** Every poll answers 429 with a Retry-After of an hour. */
    pollRateLimited?: boolean;
    /** Every instance start answers that the World is still being prepared. */
    preparing?: boolean;
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
          // The World import's report by app account.
          report: options.report ?? {
            stored: [
              { app: "linear", instanceKey: "linear", collection: "issues", count: 1200 },
              { app: "linear", instanceKey: "linear", collection: "users", count: 40 },
            ],
            normalized: [{ app: "linear", code: "date_format", count: 3 }],
            standIns: [],
            assumptions: [{ app: "linear", collection: "issues", field: "priority", count: 2 }],
            notSimulated: [{ app: "slack", account: "T01", kind: "webhooks", count: 1 }],
            excluded: [],
            truncated: true,
          },
        }
      : {}),
    ...(status === "failed"
      ? {
          errorCode: options.failCode ?? "records_invalid",
          faults: [{ code: "missing_field", kind: "Issue", id: "issue-9", field: "title" }],
        }
      : {}),
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
        if (options.pollRateLimited)
          return Response.json({}, { status: 429, headers: { "retry-after": "3600" } });
        const status = statuses[Math.min(polls++, statuses.length - 1)]!;
        return Response.json({ worldCreation: creation(status) });
      }
      if (url.pathname === "/api/v1/instances" && request.method === "POST") {
        if (options.preparing)
          return Response.json(
            { error: "World is preparing" },
            { status: 503, headers: { "x-hue-diagnostic": "world_preparing", "retry-after": "1" } },
          );
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
        "Stored: 1240",
        "  linear issues: 1200",
        "  linear users: 40",
        "Normalized: 3",
        "  linear date_format: 3",
        "Stand-ins: none",
        "Assumptions: 2",
        "  linear issues.priority: 2",
        "Not simulated: 1",
        "  slack (T01) webhooks: 1",
        "Excluded: none",
        "The report lists its first rows only.",
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

  test("names one app's files by their paths under --files, so none share a name", async () => {
    const stand = hue();
    const dir = await scratch();
    await mkdir(join(dir, "data", "linear"), { recursive: true });
    await writeFile(join(dir, "data", "issues.json"), '[{"id":"a"}]');
    await writeFile(join(dir, "data", "linear", "issues.json"), '[{"id":"b"}]');
    const result = await world(
      ["create", "--apps", "linear", "--files", "data", "--origin", stand.origin],
      { cwd: dir },
    );
    expect(result.code).toBe(0);
    const sources = stand.creations[0]!.sources as { files: Declared[] };
    expect(sources.files[0]!.files.map((file) => file.name)).toEqual([
      "issues.json",
      "linear/issues.json",
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
    expect(result.stderr).toContain("  code missing_field, kind Issue, id issue-9, field title");
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

  test("prints a refusal's code and faults", async () => {
    const stand = hue({
      createStatus: 422,
      createBody: {
        error: "not_yet_supported",
        faults: [{ code: "several_apps_with_files", field: "sources.files" }],
      },
    });
    const dir = await scratch();
    await mkdir(join(dir, "data", "linear"), { recursive: true });
    await mkdir(join(dir, "data", "slack"), { recursive: true });
    await writeFile(join(dir, "data", "linear", "a.json"), "[]");
    await writeFile(join(dir, "data", "slack", "b.json"), "[]");
    const result = await world(
      ["create", "--apps", "linear,slack", "--files", "data", "--origin", stand.origin],
      { cwd: dir },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Error: Hue refused the request (HTTP 422, not_yet_supported).\n  code several_apps_with_files, field sources.files",
    );
    expect(stand.stored.size).toBe(0);
  });

  test("asks again when an answer breaks off", async () => {
    const stand = hue({ statuses: ["ready"] });
    let broken = false;
    const breakOnce: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!broken && String(input).endsWith("/api/v1/world-creations")) {
        broken = true;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"worldCreation":'));
            setTimeout(() => controller.error(new Error("connection lost")), 5);
          },
        });
        return new Response(body, { status: 201 });
      }
      return fetch(input, init);
    }) as typeof fetch;
    const result = await world(
      ["create", "--apps", "linear", "--describe", "A small team", "--origin", stand.origin],
      { io: { fetch: breakOnce } },
    );
    expect(result.code).toBe(0);
    expect(result.sleeps).toContain(1000);
    expect(stand.creations.length).toBe(1);
  });

  test("waits for a slowed-down poll no longer than --wait", async () => {
    const stand = hue({ pollRateLimited: true });
    const result = await world([
      "create",
      "--apps",
      "linear",
      "--describe",
      "A small team",
      "--wait",
      "5",
      "--origin",
      stand.origin,
    ]);
    expect(result.code).toBe(1);
    expect(Math.max(...result.sleeps)).toBeLessThanOrEqual(5000);
  });

  test("refuses usage errors before calling Hue", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "data", "misc"), { recursive: true });
    await writeFile(join(dir, "data", "misc", "a.json"), "[]");
    const cases: [string[], string][] = [
      [["create"], "--apps is required"],
      [["create", "--apps", "Linear"], "not an app id"],
      [["create", "--apps", "slack", "--export-from", "linear"], "needs linear in --apps"],
      [["create", "--apps", "linear,slack", "--files", "data"], "data/misc/a.json"],
      [["create", "--apps", "linear", "--wait", "soon"], "--wait must be a whole number"],
      [["create", "--apps", "linear", "--composio-user", "u1"], "Pass both"],
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

  test("stops what the command left running before it finishes the instance", async () => {
    const stand = hue();
    const dir = await scratch();
    const pidFile = join(dir, "survivor.pid");
    // The command starts a process in its group that outlives it, then exits.
    const command = `const { spawn } = require("node:child_process");
const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(survivor.pid));
survivor.unref();`;
    const result = await world([
      "run",
      VERSION,
      "--origin",
      stand.origin,
      "--",
      process.execPath,
      "-e",
      command,
    ]);
    expect(result.code).toBe(0);
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(stand.finishes[0]!.status).toBe("completed");
  });

  test("abandons the instance when the MCP configuration cannot be written", async () => {
    const stand = hue();
    const cwd = await scratch();
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = join(cwd, "missing", "directory");
    try {
      const result = await world(["run", VERSION, "--origin", stand.origin, "--", "true"], { cwd });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Unable to write the MCP configuration file: ENOENT");
      expect(stand.finishes[0]!.status).toBe("abandoned");
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  test("a stop while the World is being prepared ends the wait", async () => {
    const stand = hue({ preparing: true });
    let stop: ((signal: NodeJS.Signals) => void) | undefined;
    const pending = world(["run", VERSION, "--origin", stand.origin, "--", "true"], {
      io: { onInterrupt: (listener) => ((stop = listener), () => {}) },
    });
    while (!stand.requests.includes("POST /api/v1/instances")) await Bun.sleep(20);
    const stoppedAt = performance.now();
    stop!("SIGINT");
    const result = await pending;
    expect(result.code).toBe(130);
    expect(performance.now() - stoppedAt).toBeLessThan(5000);
    expect(result.stderr).toContain("Stopped before the instance started.");
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

// Synthetic app APIs for `--export-from`, served through the command's fetch seam. They follow
// the public contracts: Linear's GraphQL API (cursor pages, RATELIMITED with reset instants,
// field errors with a path), Composio's tool execution (`data` holds Linear's body), Slack's Web
// API (cursor pages, `ok: false`, 429 with Retry-After) and Salesforce's REST API (describe,
// query and queryAll pages). Nothing reaches the real services.

const LINEAR_KEY = "lin_api_synthetic_export_key";
const SLACK_TOKEN = "xoxp-synthetic-export-token";
const SALESFORCE_TOKEN = "00D000000000001!synthetic.access.token";

type Handler = (request: Request) => Response | Promise<Response>;
function route(handlers: Record<string, Handler>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const handler = Object.entries(handlers).find(([prefix]) => request.url.startsWith(prefix));
    return handler ? handler[1](request) : fetch(input, init);
  }) as typeof fetch;
}

const page = (nodes: unknown[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});

/** Linear's GraphQL API over a three-issue workspace. */
function linearApi() {
  const queries: { query: string; variables: Record<string, string | null> }[] = [];
  let limited = false;
  const issue = (id: string, labels = page([{ id: "label-1" }])) => ({
    __typename: "Issue",
    id,
    title: `Issue ${id}`,
    labels,
  });
  const answer = (query: string, variables: Record<string, string | null>) => {
    queries.push({ query, variables });
    const root = /^query (?:\([^)]*\) )?\{ (\w+)/.exec(query)![1]!;
    if (root === "organization")
      return query.includes(" samlEnabled ")
        ? {
            data: { organization: null },
            errors: [
              {
                message: "Only admins can read this field",
                path: ["organization", "samlEnabled"],
                extensions: { code: "FORBIDDEN" },
              },
            ],
          }
        : { data: { organization: { __typename: "Organization", id: "org-1", name: "Acme" } } };
    if (root === "users")
      return { data: { users: page([{ __typename: "User", id: "user-1", isMe: true }]) } };
    if (root === "issues")
      return variables.after === null
        ? {
            data: {
              issues: page(
                [issue("issue-1", page([{ id: "label-1" }], "labels-cursor")), issue("issue-2")],
                "issues-cursor",
              ),
            },
          }
        : { data: { issues: page([issue("issue-3")]) } };
    if (root === "issue") {
      expect(variables).toEqual({ id: "issue-1", after: "labels-cursor" });
      return { data: { issue: { labels: page([{ id: "label-2" }]) } } };
    }
    return { data: { [root]: page([]) } };
  };
  const handler: Handler = async (request) => {
    expect(request.headers.get("authorization")).toBe(LINEAR_KEY);
    const { query, variables } = (await request.json()) as {
      query: string;
      variables: Record<string, string | null>;
    };
    if (query.includes("{ teams(") && !limited) {
      limited = true;
      return Response.json(
        { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] },
        { status: 400, headers: { "x-ratelimit-requests-reset": String(Date.now() + 5000) } },
      );
    }
    return Response.json(answer(query, variables));
  };
  return { queries, answer, handler };
}

const json = async (bytes: Buffer | undefined) => JSON.parse(bytes!.toString("utf8")) as unknown;

describe("hue world create --export-from", () => {
  test("linear: pages every list, completes nested lists, drops a refused field and waits out the rate limit", async () => {
    const stand = hue();
    const api = linearApi();
    const result = await world(
      ["create", "--apps", "linear", "--export-from", "linear", "--origin", stand.origin],
      {
        env: { LINEAR_API_KEY: LINEAR_KEY },
        io: { fetch: route({ "https://api.linear.app/graphql": api.handler }) },
      },
    );
    expect(result.stderr).toContain(
      "Linear refused organization.samlEnabled for this key; exporting organization without it.",
    );
    expect(result.code).toBe(0);
    expect(result.sleeps.some((ms) => ms > 3000 && ms <= 5000)).toBe(true);
    expect(stand.creations[0]!.sources).toEqual({
      files: [
        {
          app: "linear",
          files: [
            {
              name: "linear-export-1.json",
              byteSize: expect.any(Number),
              sha256: expect.any(String),
            },
          ],
        },
      ],
    });
    const records = (await json(stand.stored.get("linear-1"))) as Record<string, unknown>[];
    expect(records).toEqual([
      { __typename: "Organization", id: "org-1", name: "Acme" },
      { __typename: "User", id: "user-1", isMe: true },
      {
        __typename: "Issue",
        id: "issue-1",
        title: "Issue issue-1",
        labels: {
          nodes: [{ id: "label-1" }, { id: "label-2" }],
          pageInfo: { hasNextPage: false, endCursor: "labels-cursor" },
        },
      },
      {
        __typename: "Issue",
        id: "issue-2",
        title: "Issue issue-2",
        labels: page([{ id: "label-1" }]),
      },
      {
        __typename: "Issue",
        id: "issue-3",
        title: "Issue issue-3",
        labels: page([{ id: "label-1" }]),
      },
    ]);
    // Every list of the guide was asked for, the dropped field gone from the organization query.
    const roots = api.queries.map((item) => /\{ (\w+)/.exec(item.query)![1]);
    expect(new Set(roots).size).toBe(21);
    expect(
      api.queries.filter((item) => item.query.startsWith("query { organization")).at(-1)!.query,
    ).not.toContain("samlEnabled");
    expect(result.stdout + result.stderr).not.toContain(LINEAR_KEY);
  });

  test("linear through Composio: runs the guide's queries on the connected account and names it to Hue", async () => {
    const stand = hue();
    const api = linearApi();
    const executions: Record<string, unknown>[] = [];
    const composio: Handler = async (request) => {
      expect(request.headers.get("x-api-key")).toBe("ak_synthetic_composio");
      const body = (await request.json()) as {
        arguments: { query_or_mutation: string; variables: Record<string, string | null> };
      };
      executions.push(body);
      return Response.json({
        data: api.answer(body.arguments.query_or_mutation, body.arguments.variables),
        successful: true,
        error: null,
      });
    };
    const result = await world(
      [
        "create",
        "--apps",
        "linear",
        "--export-from",
        "linear",
        "--composio-user",
        "user-42",
        "--composio-account",
        "ca_synthetic",
        "--origin",
        stand.origin,
      ],
      {
        env: { COMPOSIO_API_KEY: "ak_synthetic_composio" },
        io: { fetch: route({ "https://backend.composio.dev/": composio }) },
      },
    );
    expect(result.code).toBe(0);
    expect(executions[0]).toMatchObject({
      connected_account_id: "ca_synthetic",
      user_id: "user-42",
      version: "latest",
    });
    expect((stand.creations[0]!.sources as Record<string, unknown>).composio).toEqual({
      linear: { userId: "user-42", connectedAccountId: "ca_synthetic" },
    });
    expect(((await json(stand.stored.get("linear-1"))) as unknown[]).length).toBe(5);
  });

  test("slack: records every call of the list as an exchange, answers and headers as Slack gave them", async () => {
    const stand = hue();
    const calls: string[] = [];
    let limited = false;
    const slack: Handler = (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${SLACK_TOKEN}`);
      const url = new URL(request.url);
      const method = url.pathname.slice("/api/".length);
      const args = Object.fromEntries(url.searchParams);
      calls.push(`${method} ${url.searchParams}`);
      const ok = (body: Record<string, unknown>) =>
        Response.json(
          { ok: true, ...body },
          { headers: { "x-oauth-scopes": "channels:history,users:read" } },
        );
      const done = { response_metadata: { next_cursor: "" } };
      switch (method) {
        case "auth.test":
          return ok({ user_id: "U1", team_id: "T1" });
        case "users.list":
          return args.cursor
            ? ok({ members: [{ id: "U2" }], ...done })
            : ok({ members: [{ id: "U1" }], response_metadata: { next_cursor: "users-2" } });
        case "conversations.list":
          return ok({
            channels: [
              { id: "C1", is_channel: true },
              { id: "D1", is_im: true },
            ],
            ...done,
          });
        case "users.conversations":
          return ok({
            channels: [
              { id: "C1", is_channel: true },
              { id: "G1", is_group: true },
            ],
            ...done,
          });
        case "conversations.history":
          if (args.channel === "C1" && !limited) {
            limited = true;
            return new Response("", { status: 429, headers: { "retry-after": "3" } });
          }
          if (args.channel === "G1") return Response.json({ ok: false, error: "not_in_channel" });
          return ok({
            messages:
              args.channel === "C1" ? [{ ts: "1.000", reply_count: 2 }, { ts: "2.000" }] : [],
            has_more: false,
          });
        case "reactions.list":
          // Numbered pages, without a cursor.
          return ok({
            items: [{ type: "message" }],
            paging: { page: Number(args.page ?? 1), pages: 2 },
          });
        case "files.list":
          return ok({
            files: [{ id: `F${args.page}` }],
            paging: { page: Number(args.page), pages: 2 },
          });
        default:
          return ok(method.startsWith("conversations.") || method === "reactions.list" ? done : {});
      }
    };
    const result = await world(
      ["create", "--apps", "slack", "--export-from", "slack", "--origin", stand.origin],
      { env: { SLACK_TOKEN }, io: { fetch: route({ "https://slack.com/api/": slack }) } },
    );
    expect(result.code).toBe(0);
    expect(result.sleeps).toContain(3000);
    expect(calls).toEqual([
      "auth.test ",
      "team.info ",
      "users.list limit=200",
      "users.list limit=200&cursor=users-2",
      "conversations.list types=public_channel%2Cprivate_channel%2Cmpim%2Cim&exclude_archived=false&limit=200",
      "users.conversations types=public_channel%2Cprivate_channel%2Cmpim%2Cim&exclude_archived=false&limit=200",
      "conversations.info channel=C1",
      "conversations.members channel=C1&limit=1000",
      "conversations.history channel=C1&limit=999",
      "conversations.history channel=C1&limit=999",
      "conversations.replies channel=C1&ts=1.000&limit=999",
      "pins.list channel=C1",
      "bookmarks.list channel_id=C1",
      "conversations.info channel=D1",
      "conversations.history channel=D1&limit=999",
      "conversations.info channel=G1",
      "conversations.members channel=G1&limit=1000",
      "conversations.history channel=G1&limit=999",
      "pins.list channel=G1",
      "bookmarks.list channel_id=G1",
      "files.list count=100&page=1",
      "files.list count=100&page=2",
      "reactions.list ",
      "reactions.list page=2",
      "users.profile.get user=U1",
      "dnd.teamInfo ",
    ]);
    const exchanges = (await json(stand.stored.get("slack-1"))) as {
      request: { method: string; url: string; body: null };
      response: { status: number; headers: Record<string, string>; body: unknown };
    }[];
    // The rate-limited attempt is waited out, not recorded.
    expect(exchanges.length).toBe(calls.length - 1);
    expect(exchanges[0]).toEqual({
      request: { method: "GET", url: "https://slack.com/api/auth.test", body: null },
      response: {
        status: 200,
        headers: expect.objectContaining({ "x-oauth-scopes": "channels:history,users:read" }),
        body: { ok: true, user_id: "U1", team_id: "T1" },
      },
    });
    expect(
      exchanges.find((item) => item.request.url.includes("channel=G1&limit=999"))!.response.body,
    ).toEqual({
      ok: false,
      error: "not_in_channel",
    });
    expect(JSON.stringify(exchanges)).not.toContain(SLACK_TOKEN);
    expect(result.stderr).toContain(
      "Slack: 1 call answered ok: false, kept as Slack answered them (conversations.history not_in_channel ×1).",
    );
  });

  test("salesforce: describes each object and pages queryAll, or query without IsDeleted", async () => {
    const stand = hue();
    const paths: string[] = [];
    // A custom object too wide for one query URL: 600 long field names.
    const wide = Array.from({ length: 600 }, (_, i) => `Customer_Satisfaction_Score_${i}__c`);
    const wideQueries: { fields: string[]; urlLength: number }[] = [];
    const describe = (fields: [string, string][]) =>
      Response.json({ fields: fields.map(([name, type]) => ({ name, type })) });
    const salesforce: Handler = (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${SALESFORCE_TOKEN}`);
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`.replace("/services/data/v67.0", "");
      paths.push(path);
      if (path.includes("query"))
        expect(request.headers.get("sforce-query-options")).toBe("batchSize=2000");
      switch (url.pathname.replace("/services/data/v67.0", "")) {
        case "/chatter/users/me":
          return Response.json({ id: "005000000000001" });
        case "/sobjects":
          return Response.json({
            sobjects: [
              { name: "Account", custom: false, queryable: true },
              { name: "User", custom: false, queryable: true },
              { name: "Widget__c", custom: true, queryable: true },
              { name: "Wide__c", custom: true, queryable: true },
              { name: "Hidden__c", custom: true, queryable: false },
              { name: "Setting__mdt", custom: true, queryable: true },
            ],
          });
        case "/sobjects/Account/describe":
          return describe([
            ["Id", "id"],
            ["Name", "string"],
            ["IsDeleted", "boolean"],
            ["BillingAddress", "address"],
            ["Logo", "base64"],
          ]);
        case "/sobjects/User/describe":
          return describe([
            ["Id", "id"],
            ["Username", "string"],
          ]);
        case "/sobjects/Widget__c/describe":
          return Response.json([{ errorCode: "NOT_FOUND", message: "gone" }], { status: 404 });
        case "/sobjects/Wide__c/describe":
          return describe([
            ["Id", "id"],
            ["IsDeleted", "boolean"],
            ...wide.map((name): [string, string] => [name, "double"]),
          ]);
        case "/queryAll":
          if (url.searchParams.get("q")!.endsWith(" FROM Wide__c")) {
            const fields = /^SELECT (.*) FROM Wide__c$/
              .exec(url.searchParams.get("q")!)![1]!
              .split(",");
            wideQueries.push({ fields, urlLength: request.url.length });
            return Response.json({
              totalSize: 1,
              done: true,
              records: [
                Object.fromEntries(fields.map((field) => [field, field === "Id" ? "a0W1" : 1])),
              ],
            });
          }
          return Response.json({
            totalSize: 3,
            done: false,
            nextRecordsUrl: "/services/data/v67.0/query/01gA-2000",
            records: [{ Id: "001A" }, { Id: "001B" }],
          });
        case "/query/01gA-2000":
          return Response.json({ totalSize: 3, done: true, records: [{ Id: "001C" }] });
        case "/query":
          return Response.json({ totalSize: 1, done: true, records: [{ Id: "005A" }] });
      }
      return Response.json([{ errorCode: "NOT_FOUND" }], { status: 404 });
    };
    const result = await world(
      ["create", "--apps", "salesforce", "--export-from", "salesforce", "--origin", stand.origin],
      {
        env: {
          SALESFORCE_ACCESS_TOKEN: SALESFORCE_TOKEN,
          SALESFORCE_INSTANCE_URL: "https://acme.my.salesforce.com",
        },
        io: { fetch: route({ "https://acme.my.salesforce.com/": salesforce }) },
      },
    );
    expect(result.code).toBe(0);
    // The standard objects in the list's order, then the queryable custom objects; an object
    // whose describe fails is recorded and not queried.
    expect(paths.slice(0, 9)).toEqual([
      "/chatter/users/me",
      "/sobjects",
      "/sobjects/User/describe",
      "/query?q=SELECT+Id%2CUsername+FROM+User",
      "/sobjects/Account/describe",
      "/queryAll?q=SELECT+Id%2CName%2CIsDeleted+FROM+Account",
      "/query/01gA-2000",
      "/sobjects/Widget__c/describe",
      "/sobjects/Wide__c/describe",
    ]);
    // The wide object is read in field groups: each within the URL budget, each with Id and
    // IsDeleted, together every field once.
    expect(wideQueries.length).toBeGreaterThan(1);
    for (const query of wideQueries) {
      expect(query.urlLength).toBeLessThanOrEqual(12_000);
      expect(query.fields.slice(0, 2)).toEqual(["Id", "IsDeleted"]);
    }
    expect(wideQueries.flatMap((query) => query.fields.slice(2))).toEqual(wide);
    expect(result.stderr).toContain(`Salesforce: 1 Wide__c in ${wideQueries.length} field groups`);
    expect(result.stderr).toContain(
      `Salesforce: read 1 wide object in field groups to stay within the URL limit: Wide__c (${wideQueries.length}).`,
    );
    expect(result.stderr).toContain("Salesforce: 3 Account");
    expect(result.stderr).toContain(
      "Salesforce: describing Widget__c answered HTTP 404; Widget__c is not exported.",
    );
    const exchanges = (await json(stand.stored.get("salesforce-1"))) as {
      request: { url: string };
    }[];
    expect(exchanges.map((item) => item.request.url)).toContain(
      "https://acme.my.salesforce.com/services/data/v67.0/query/01gA-2000",
    );
    expect(JSON.stringify(exchanges)).not.toContain(SALESFORCE_TOKEN);
  });

  test("gmail: reads every message in full, raw ones with attachments, and the drafts", async () => {
    const stand = hue();
    const token = "ya29.synthetic-gmail-access-token";
    let limited = false;
    const gmail: Handler = (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      const url = new URL(request.url);
      const path = `${url.pathname.replace("/gmail/v1/users/me", "")}${url.search}`;
      const attachment = {
        parts: [{ body: { size: 5 } }, { parts: [{ body: { attachmentId: "a1" } }] }],
      };
      switch (path) {
        case "/profile":
          return Response.json({ emailAddress: "owner@example.test" });
        case "/labels":
          return Response.json({ labels: [{ id: "INBOX" }] });
        case "/messages?includeSpamTrash=true&maxResults=500":
          return Response.json({ messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "p2" });
        case "/messages?includeSpamTrash=true&maxResults=500&pageToken=p2":
          return Response.json({ messages: [{ id: "m3" }] });
        case "/messages/m1?format=full":
          return Response.json({ id: "m1", sizeEstimate: 1000, payload: attachment });
        case "/messages/m2?format=full":
          return Response.json({ id: "m2", sizeEstimate: 500_000, payload: attachment });
        case "/messages/m3?format=full":
          if (!limited) {
            limited = true;
            return Response.json(
              { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } },
              { status: 403 },
            );
          }
          return Response.json({ id: "m3", sizeEstimate: 800, payload: { body: { size: 9 } } });
        case "/messages/m1?format=raw":
          return Response.json({ id: "m1", raw: "RnJvbTogb3duZXI" });
        case "/drafts?maxResults=500":
          return Response.json(
            { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } },
            { status: 403 },
          );
      }
      return Response.json({ error: { code: 404 } }, { status: 404 });
    };
    const result = await world(
      ["create", "--apps", "gmail", "--export-from", "gmail", "--origin", stand.origin],
      {
        env: { GMAIL_ACCESS_TOKEN: token },
        io: { fetch: route({ "https://gmail.googleapis.com/gmail/v1/users/me": gmail }) },
      },
    );
    expect(result.code).toBe(0);
    expect(result.sleeps).toContain(5000);
    const exchanges = (await json(stand.stored.get("gmail-1"))) as {
      request: { url: string };
      response: { status: number };
    }[];
    // In the order the calls were made, without the rate-limited attempt; m2 is too large to be
    // read again in raw format and m3 has no attachment.
    expect(exchanges.map((item) => item.request.url.replace(/^.*\/users\/me/, ""))).toEqual([
      "/profile",
      "/labels",
      "/messages?includeSpamTrash=true&maxResults=500",
      "/messages?includeSpamTrash=true&maxResults=500&pageToken=p2",
      "/messages/m1?format=full",
      "/messages/m2?format=full",
      "/messages/m3?format=full",
      "/messages/m1?format=raw",
      "/drafts?maxResults=500",
    ]);
    // A refused list is recorded as Gmail answered it, and named.
    expect(exchanges.map((item) => item.response.status)).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 403,
    ]);
    expect(result.stderr).toContain(
      "Gmail: listing /drafts?maxResults=500 answered HTTP 403; the list is incomplete.",
    );
    expect(JSON.stringify(exchanges)).not.toContain(token);
  });

  test("refuses an export without its credentials before reading anything", async () => {
    const cases: [string, string][] = [
      ["linear", "LINEAR_API_KEY"],
      ["slack", "SLACK_TOKEN"],
      ["salesforce", "SALESFORCE_INSTANCE_URL"],
      ["gmail", "GMAIL_ACCESS_TOKEN"],
      ["jira", "--export-from reads linear, slack, salesforce, gmail"],
      ["constructor", "--export-from reads linear, slack, salesforce, gmail"],
    ];
    for (const [app, message] of cases) {
      const result = await world([
        "create",
        "--apps",
        app,
        "--export-from",
        app,
        "--origin",
        "http://127.0.0.1:9",
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
    }
  });
});
