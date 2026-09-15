import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  InMemoryTransport,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { createPlaybackMcpServer } from "../src/scenes-mcp.js";
import {
  ScenesClient,
  CaptureSession,
  Playback,
  wrapTool,
  wrapFetch,
  wrapMcpClient,
  wrapAiTools,
  canonical,
  requestKey,
  SnapshotMissError,
  RecordedToolError,
  type Binding,
  type Manifest,
  type Observation,
  type Source,
  type MissReason,
} from "../src/scenes.js";
import fixtures from "./fixtures/scenes-v1.json" with { type: "json" };
const hash = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
const binding: Binding = {
  id: "docs",
  kind: "tool",
  contractVersion: "1",
  operations: [{ name: "search", inputSchema: { type: "object" } }],
};
class Hosted {
  observations: Observation[] = [];
  sources: Source[] = [];
  events: unknown[] = [];
  bodies: string[] = [];
  bindings: Binding[] = [];
  revision = 0;
  artifactCount = 0;
  outage = false;
  corrupt = false;
  bytes = new Map<string, Uint8Array>();
  reservations = new Map<string, { sha256: string; byteSize: number }>();
  manifest?: Manifest;
  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const raw = typeof init?.body === "string" ? init.body : undefined;
    if (raw) this.bodies.push(raw);
    const body = raw ? JSON.parse(raw) : {};
    if (path === "/api/v1/scenes") {
      this.bindings = body.bindings;
      return Response.json({ id: "scene", captureRevision: ++this.revision });
    }
    if (path.endsWith("/observations")) {
      if (this.outage) return new Response(null, { status: 503 });
      this.observations.push(...body.observations);
      return Response.json({
        accepted: body.observations.length,
        captureRevision: ++this.revision,
      });
    }
    if (path.endsWith("/sources")) {
      this.sources.push(...body.sources);
      return Response.json({
        accepted: body.sources.length,
        captureRevision: ++this.revision,
      });
    }
    if (path.endsWith("/finalize")) {
      this.manifest = {
        schemaVersion: "1",
        sceneId: "scene",
        projectId: "project",
        revision: this.revision,
        externalTraceId: "1".repeat(32),
        bindings: this.bindings,
        observations: structuredClone(this.observations),
        sources: structuredClone(this.sources),
        producers: body.producers,
        createdAt: "2026-09-15T00:00:00.000Z",
      };
      return Response.json({
        sceneId: "scene",
        revision: this.revision,
        digest: hash(canonical(this.manifest)),
      });
    }
    if (path.includes("/revisions/"))
      return Response.json({
        manifest: this.manifest,
        digest: hash(canonical(this.manifest)),
      });
    if (path === "/api/v1/scene-replays")
      return Response.json({ id: "replay" });
    if (path.endsWith("/events")) {
      this.events.push(...body.events);
      return Response.json({ accepted: body.events.length });
    }
    if (path === "/api/v1/artifacts") {
      const id = `artifact-${++this.artifactCount}`;
      this.reservations.set(id, body);
      return Response.json({ id });
    }
    if (path.endsWith("/upload"))
      return Response.json({
        method: "PUT",
        uploadUrl: `https://storage.test/${path.split("/").at(-2)}`,
        headers: { "x-upload": "synthetic" },
        expiresAt: "2099-01-01",
      });
    if (String(input).startsWith("https://storage.test/")) {
      this.bytes.set(path.slice(1), new Uint8Array(init?.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    if (path.endsWith("/download")) {
      const b = this.bytes.get(path.split("/").at(-2)!)!;
      return new Response(
        this.corrupt ? new Uint8Array([1]) : new Uint8Array(b),
      );
    }
    if (path.includes("/artifacts/") && path.endsWith("/complete")) {
      const r = this.reservations.get(path.split("/").at(-2)!)!;
      return Response.json({
        state: "ready",
        verifiedBytes: r.byteSize,
        verifiedSha256: r.sha256,
      });
    }
    if (path.endsWith("/complete"))
      return Response.json({ id: "replay", state: body.state, missCount: 0 });
    throw new Error(`Unexpected synthetic route ${path}`);
  }) as unknown as typeof fetch;
  client(options: Partial<ConstructorParameters<typeof ScenesClient>[0]> = {}) {
    return new ScenesClient({
      apiKey: "synthetic-scenes-key",
      capture: true,
      fetch: this.fetch,
      ...options,
    });
  }
  async capture(
    bindings: Binding[] = [binding],
    options: Partial<ConstructorParameters<typeof ScenesClient>[0]> = {},
  ) {
    return CaptureSession.create(this.client(options), {
      bindings,
      externalTraceId: "1".repeat(32),
    });
  }
}
async function frozen(host: Hosted, capture: CaptureSession, ids = ["docs"]) {
  const pin = await capture.finalize();
  return Playback.load(capture.client, pin, ids);
}
function reason(fn: () => unknown, expected: MissReason) {
  try {
    fn();
    throw new Error("Expected miss");
  } catch (e) {
    expect(e).toBeInstanceOf(SnapshotMissError);
    expect((e as SnapshotMissError).reason).toBe(expected);
  }
}

describe("Scenes portable protocol and capture", () => {
  test("shared JCS and key fixtures; strict JSON rejects getters and ambiguous numbers", () => {
    for (const f of fixtures.canonical)
      expect(canonical(f.value)).toBe(f.canonical);
    for (const f of fixtures.matching)
      expect(
        requestKey(
          {
            id: f.arguments.bindingId,
            kind: "tool",
            contractVersion: f.arguments.contractVersion,
          },
          f.arguments.operation,
          f.arguments.arguments,
        ),
      ).toBe(f.sha256);
    expect(canonical({ "2": 2, "10": 10 })).toBe('{"10":10,"2":2}');
    expect(() => canonical({ x: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    let accessed = 0;
    const a = [0];
    Object.defineProperty(a, "0", { get: () => ++accessed });
    expect(() => canonical(a)).toThrow();
    expect(accessed).toBe(0);
    expect(() => canonical("\ud800")).toThrow();
  });
  test("FIFO, independent reorder, immutable results, async return mode, no live fallback", async () => {
    const host = new Hosted(),
      capture = await host.capture();
    let live = 0;
    const tool = wrapTool("docs", "search", (q: unknown) => ({ n: ++live, q }));
    capture.run(() => {
      tool({ q: "a" });
      tool({ q: "b" });
      tool({ q: "a" });
    });
    const playback = await frozen(host, capture);
    playback.run(() => {
      expect(tool({ q: "b" })).toEqual({ n: 2, q: { q: "b" } });
      const a = tool({ q: "a" });
      a.n = 99;
      expect(tool({ q: "a" }).n).toBe(3);
      reason(() => tool({ q: "a" }), "exhausted");
      reason(() => tool({ q: "changed" }), "unrecorded");
    });
    expect(live).toBe(3);
    await Promise.all([playback.flush(), playback.flush()]);
    expect(host.events).toHaveLength(5);
  });
  test("Promise wrappers replay fulfillment and arbitrary recorded exceptions", async () => {
    const host = new Hosted(),
      capture = await host.capture();
    let live = 0;
    const tool = wrapTool("docs", "search", async (q: string) => {
      live++;
      if (q === "bad") throw new TypeError("secret exception data");
      return "ok";
    });
    await capture.run(async () => {
      await tool("good");
      await expect(tool("bad")).rejects.toThrow(TypeError);
    });
    const playback = await frozen(host, capture);
    await playback.run(async () => {
      expect(tool("good")).toBeInstanceOf(Promise);
      await expect(tool("bad")).rejects.toBeInstanceOf(RecordedToolError);
      await expect(tool("unknown")).rejects.toBeInstanceOf(SnapshotMissError);
    });
    expect(live).toBe(2);
    expect(host.bodies.join("")).not.toContain("secret exception data");
  });
  test("credentials removed before queue; redacted output cannot masquerade as complete", async () => {
    const host = new Hosted(),
      capture = await host.capture();
    const tool = wrapTool("docs", "search", (_: unknown) => ({
      token: "output-secret",
      title: "file",
    }));
    capture.run(() =>
      tool({
        q: "x",
        authorization: "input-secret",
        nested: { password: "nested-secret" },
      }),
    );
    const p = await frozen(host, capture);
    expect(host.bodies.join("")).not.toContain("input-secret");
    expect(host.bodies.join("")).not.toContain("nested-secret");
    expect(host.bodies.join("")).not.toContain("output-secret");
    p.run(() =>
      reason(
        () =>
          tool({
            q: "x",
            authorization: "different",
            nested: { password: "new" },
          }),
        "incomplete",
      ),
    );
  });
  test("outages and queue overflow preserve application outcome and report drops", async () => {
    const host = new Hosted(),
      issues: string[] = [],
      capture = await host.capture([binding], {
        maxQueueRecords: 1,
        onIssue: (i) => issues.push(i.kind),
      });
    host.outage = true;
    const tool = wrapTool("docs", "search", () => 42);
    expect(capture.run(() => tool())).toBe(42);
    const result = await capture.flush();
    expect(result.dropped).toBe(2);
    expect(issues).toContain("dropped");
    expect(issues).toContain("failed");
  });
  test("client memory budget is shared by concurrent sessions", async () => {
    const host = new Hosted(),
      client = host.client({ maxQueueRecords: 1 });
    const a = await CaptureSession.create(client, {
        bindings: [binding],
        externalTraceId: "1".repeat(32),
      }),
      b = await CaptureSession.create(client, {
        bindings: [binding],
        externalTraceId: "1".repeat(32),
      });
    const tool = wrapTool("docs", "search", () => 1);
    a.run(() => tool());
    b.run(() => tool());
    expect((await b.flush()).dropped).toBe(2);
    await a.flush();
  });
  test("blob upload/download hash checked before exposing data; sources are explicit", async () => {
    const host = new Hosted(),
      capture = await host.capture(),
      bytes = new Uint8Array(300000).fill(7);
    const tool = wrapTool("docs", "search", () => bytes);
    capture.run(() => tool());
    await capture.source({
      id: "attachment",
      name: "input.pdf",
      mimeType: "application/pdf",
      relation: "query_attachment",
      bytes,
    });
    const p = await frozen(host, capture);
    expect(host.sources[0].content).toBe("complete");
    expect(host.artifactCount).toBe(2);
    expect(p.run(() => tool())).toEqual(bytes);
    host.corrupt = true;
    const broken = await Playback.load(
      capture.client,
      {
        sceneId: "scene",
        revision: host.manifest!.revision,
        digest: hash(canonical(host.manifest)),
      },
      ["docs"],
    );
    broken.run(() => reason(() => tool(), "integrity"));
  });
  test("unsupported values and cyclic arguments do not change the live return", async () => {
    const host = new Hosted(),
      capture = await host.capture();
    const date = new Date(),
      tool = wrapTool("docs", "search", () => date);
    expect(capture.run(() => tool())).toBe(date);
    const p = await frozen(host, capture);
    p.run(() => reason(() => tool(), "incomplete"));
  });
});
describe("Scenes concurrency and streams", () => {
  test("concurrent identical requests with differing results are ambiguous", async () => {
    const host = new Hosted(),
      capture = await host.capture();
    let n = 0;
    const resolvers: ((n: number) => void)[] = [];
    const tool = wrapTool("docs", "search", async (q: string) => {
      n++;
      return new Promise<number>((r) => resolvers.push(r));
    });
    await capture.run(async () => {
      const a = tool("same"),
        b = tool("same");
      resolvers[1](2);
      resolvers[0](1);
      await Promise.all([a, b]);
    });
    const p = await frozen(host, capture);
    await p.run(() =>
      expect(tool("same")).rejects.toMatchObject({ reason: "ambiguous" }),
    );
    expect(n).toBe(2);
  });
  test("nested selected bindings reject configuration before running", async () => {
    const host = new Hosted(),
      capture = await host.capture([binding, { ...binding, id: "child" }]);
    const child = wrapTool("child", "search", () => 4),
      parent = wrapTool("docs", "search", () => child());
    capture.run(() => parent());
    const pin = await capture.finalize();
    await expect(
      Playback.load(capture.client, pin, ["docs", "child"]),
    ).rejects.toMatchObject({ reason: "overlapping_bindings" });
    const p = await Playback.load(capture.client, pin, ["docs"]);
    expect(p.run(() => parent())).toBe(4);
  });
  test("completed async items replay with bytes, abandoned/cancelled streams miss", async () => {
    const host = new Hosted(),
      capture = await host.capture();
    let live = 0;
    const tool = wrapTool("docs", "search", async function* (q: string) {
      live++;
      yield { q };
      yield new Uint8Array([1, 2]);
    });
    await capture.run(async () => {
      for await (const _ of tool("full")) {
      }
      const cancelled = tool("cancelled")[Symbol.asyncIterator]();
      await cancelled.next();
      await cancelled.return?.();
      await tool("open")[Symbol.asyncIterator]().next();
    });
    const pin = await capture.finalize(1);
    expect(host.manifest!.producers[0].pending).toBe(1);
    const p = await Playback.load(capture.client, pin, ["docs"]);
    await p.run(async () => {
      const values = [];
      for await (const value of tool("full")) values.push(value);
      expect(values).toEqual([{ q: "full" }, new Uint8Array([1, 2])]);
      reason(() => tool("cancelled"), "incomplete");
      reason(() => tool("open"), "incomplete");
    });
    expect(live).toBe(3);
  });
  test("cancelled streams release bounded capture memory", async () => {
    const host = new Hosted(),
      capture = await host.capture([binding], { maxQueueBytes: 200 });
    const tool = wrapTool("docs", "search", async function* () {
      yield new Uint8Array(100);
    });
    const iterator = capture.run(() => tool()[Symbol.asyncIterator]());
    await iterator.next();
    await iterator.return?.();
    await capture.flush();
    expect(capture.client.reserve(200)).toBe(true);
    capture.client.release(200);
  });
});
describe("HTTP and tool adapters", () => {
  test("fetch captures consumed response; errors replay; selected miss has zero upstream requests", async () => {
    const host = new Hosted(),
      http: Binding = {
        id: "http",
        kind: "http",
        contractVersion: "1",
        http: { origin: "https://source.test", pathPrefix: "/files" },
      };
    const capture = await host.capture([http]);
    let live = 0;
    const f = wrapFetch((async () => {
      live++;
      return new Response("missing", {
        status: 404,
        headers: { "content-type": "text/plain", "set-cookie": "secret" },
      });
    }) as unknown as typeof fetch);
    const url = "https://source.test/files?a=1&a=2&access_token=secret";
    await capture.run(async () =>
      expect(
        await (
          await f(url, {
            headers: { Authorization: "Bearer secret", Range: "bytes=0-9" },
          })
        ).text(),
      ).toBe("missing"),
    );
    const p = await frozen(host, capture, ["http"]);
    expect(host.bodies.join("")).not.toContain("secret");
    await p.run(async () => {
      const response = await f(
        "https://source.test/files?a=1&a=2&access_token=changed",
        { headers: { Range: "bytes=0-9" } },
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("missing");
      await expect(f("https://source.test/files/new")).rejects.toMatchObject({
        reason: "unrecorded",
      });
      await expect(f(url, { method: "POST" })).rejects.toMatchObject({
        reason: "unrecorded",
      });
    });
    expect(live).toBe(1);
  });
  test("fetch capture does not read ahead or drain unread bodies and honors cancel", async () => {
    const host = new Hosted(),
      capture = await host.capture([
        {
          id: "http",
          kind: "http",
          contractVersion: "1",
          http: { origin: "https://source.test", pathPrefix: "/" },
        },
      ]);
    let pulls = 0,
      cancelled = 0;
    const f = wrapFetch(
      (async () =>
        new Response(
          new ReadableStream(
            {
              pull(c) {
                pulls++;
                c.enqueue(new Uint8Array(100));
              },
              cancel() {
                cancelled++;
              },
            },
            { highWaterMark: 0 },
          ),
        )) as unknown as typeof fetch,
    );
    const r = await capture.run(() => f("https://source.test/file"));
    expect(pulls).toBe(0);
    const reader = r.body!.getReader();
    await reader.read();
    expect(pulls).toBe(1);
    await reader.cancel();
    expect(cancelled).toBe(1);
    await capture.finalize(1);
    expect(host.observations.at(-1)?.outcome).toBe("cancelled");
  });
  test("Request streaming and multipart bodies fail explicitly in playback", async () => {
    const host = new Hosted(),
      capture = await host.capture([
        {
          id: "http",
          kind: "http",
          contractVersion: "1",
          http: { origin: "https://source.test", pathPrefix: "/" },
        },
      ]);
    const f = wrapFetch(
      (async () => new Response("ok")) as unknown as typeof fetch,
    );
    const form = new FormData();
    form.append("file", new Blob(["abc"]));
    await capture.run(async () => {
      await (
        await f("https://source.test/file", { method: "POST", body: form })
      ).text();
    });
    const p = await frozen(host, capture, ["http"]);
    await p.run(() =>
      expect(
        f("https://source.test/file", { method: "POST", body: form }),
      ).rejects.toMatchObject({ reason: "nonportable" }),
    );
  });
  test("AI tools and MCP adapter retain options, this binding, isError and URI requests", async () => {
    const host = new Hosted(),
      capture = await host.capture([
        binding,
        { ...binding, id: "mcp", kind: "mcp" },
      ]);
    const tools = wrapAiTools("docs", {
      search: {
        description: "find",
        execute: async (q: unknown, opts: unknown) => ({ q, opts }),
      },
    });
    const target = {
      count: 0,
      async callTool(params: { name: string; arguments: unknown }) {
        this.count++;
        return {
          isError: true,
          content: [{ type: "text", text: "known error" }],
        };
      },
      async readResource(params: { uri: string }) {
        return { contents: [{ uri: params.uri, text: "document" }] };
      },
    };
    const mcp = wrapMcpClient("mcp", target);
    await capture.run(async () => {
      await tools.search.execute({ q: 1 }, { option: true });
      await mcp.callTool({ name: "search", arguments: { q: 1 } });
      await mcp.readResource({ uri: "urn:docs:1" });
    });
    const p = await frozen(host, capture, ["docs", "mcp"]);
    await p.run(async () => {
      expect(await tools.search.execute({ q: 1 }, { option: false })).toEqual({
        q: { q: 1 },
        opts: { option: true },
      });
      expect(
        (await mcp.callTool({ name: "search", arguments: { q: 1 } })).isError,
      ).toBe(true);
      expect(await mcp.readResource({ uri: "urn:docs:1" })).toEqual({
        contents: [{ uri: "urn:docs:1", text: "document" }],
      });
    });
    expect(target.count).toBe(1);
  });
});

describe("Scenes source associations and incomplete evidence", () => {
  test("HTTP PDF uses one verified artifact for payload and partial source association", async () => {
    const host = new Hosted(),
      capture = await host.capture([
        {
          id: "http",
          kind: "http",
          contractVersion: "1",
          http: { origin: "https://source.test", pathPrefix: "/" },
        },
      ]);
    const bytes = new Uint8Array([37, 80, 68, 70, 45]);
    const f = wrapFetch(
      (async () =>
        new Response(bytes, {
          status: 206,
          headers: {
            "content-type": "application/pdf",
            "content-range": "bytes 0-4/100",
          },
        })) as unknown as typeof fetch,
    );
    await capture.run(async () => {
      expect(
        new Uint8Array(
          await (await f("https://source.test/file.pdf")).arrayBuffer(),
        ),
      ).toEqual(bytes);
    });
    await capture.flush();
    expect(host.sources).toHaveLength(1);
    expect(host.sources[0].content).toBe("partial");
    expect(host.artifactCount).toBe(1);
    const p = await frozen(host, capture, ["http"]);
    await p.run(async () => {
      expect(
        new Uint8Array(
          await (await f("https://source.test/file.pdf")).arrayBuffer(),
        ),
      ).toEqual(bytes);
    });
  });
  test("MCP embedded source text is associated without following references", async () => {
    const host = new Hosted(),
      capture = await host.capture([{ ...binding, kind: "mcp" }]);
    const mcp = wrapMcpClient("docs", {
      async readResource() {
        return {
          contents: [
            {
              uri: "urn:document:1",
              mimeType: "text/plain",
              text: "source document",
            },
          ],
        };
      },
    });
    await capture.run(() => mcp.readResource());
    await capture.flush();
    expect(host.sources).toHaveLength(1);
    expect(host.sources[0].uri).toBe("urn:document:1");
    expect(host.artifactCount).toBe(1);
  });
  test("concurrent equal binary outcomes replay despite separate artifact IDs", async () => {
    const host = new Hosted(),
      capture = await host.capture();
    const tool = wrapTool("docs", "search", async () =>
      new Uint8Array(300000).fill(1),
    );
    await capture.run(() => Promise.all([tool(), tool()]));
    const p = await frozen(host, capture);
    await p.run(async () => {
      expect((await tool()).length).toBe(300000);
      expect((await tool()).length).toBe(300000);
    });
  });
  test("throwing or returning async generators remain ineligible", async () => {
    const host = new Hosted(),
      capture = await host.capture();
    const tool = wrapTool("docs", "search", async function* (input: string) {
      yield 1;
      if (input === "error") throw new TypeError("private");
      return 99;
    });
    await capture.run(async () => {
      for await (const _ of tool("return")) {
      }
      try {
        for await (const _ of tool("error")) {
        }
      } catch {}
    });
    const p = await frozen(host, capture);
    p.run(() => {
      reason(() => tool("return"), "incomplete");
      reason(() => tool("error"), "incomplete");
    });
    expect(host.bodies.join("")).not.toContain("private");
  });
  test("unsupported MCP continuation is incomplete and never solicits new live data", async () => {
    const host = new Hosted(),
      capture = await host.capture([{ ...binding, kind: "mcp" }]);
    let n = 0;
    const mcp = wrapMcpClient("docs", {
      async callTool(_: unknown) {
        n++;
        return {
          resultType: "input_required",
          inputRequests: [{ type: "elicitation" }],
        };
      },
    });
    await capture.run(() => mcp.callTool({ name: "search", arguments: {} }));
    const p = await frozen(host, capture);
    await p.run(() =>
      expect(
        mcp.callTool({ name: "search", arguments: {} }),
      ).rejects.toMatchObject({ reason: "incomplete" }),
    );
    expect(n).toBe(1);
  });
  test("missing outcomes and unknown payload variants cannot replay as undefined", async () => {
    const host = new Hosted(),
      capture = await host.capture();
    const tool = wrapTool("docs", "search", () => 7);
    capture.run(() => tool());
    await capture.finalize();
    const noOutcome = structuredClone(host.manifest!);
    delete noOutcome.observations[1].outcome;
    await expect(
      Playback.fromManifest(capture.client, noOutcome, ["docs"]),
    ).rejects.toMatchObject({ reason: "integrity" });
    const unknown = structuredClone(host.manifest!) as unknown as {
      observations: { result?: unknown }[];
    };
    unknown.observations[1].result = { kind: "future" };
    await expect(
      Playback.fromManifest(capture.client, unknown as unknown as Manifest, [
        "docs",
      ]),
    ).rejects.toMatchObject({ reason: "integrity" });
  });
});

test("capture mapping and result accessors cannot replace the live return", async () => {
  const host = new Hosted(),
    capture = await host.capture();
  const value = {
    get then(): never {
      throw new Error("never inspect");
    },
  };
  const tool = wrapTool(
    "docs",
    "search",
    () => value,
    () => {
      throw new Error("mapping failed");
    },
  );
  expect(capture.run(() => tool())).toBe(value);
  await capture.flush();
  expect(host.observations.at(-1)?.replayable).toBe(false);
});

test("native generator next/return/throw methods remain available and bidirectional capture is ineligible", async () => {
  const host = new Hosted(),
    capture = await host.capture();
  const tool = wrapTool(
    "docs",
    "search",
    async function* (q: string): AsyncGenerator<number, void, number> {
      try {
        const sent = yield 1;
        if (sent) yield sent;
      } catch {
        yield 9;
      }
    },
  );
  await capture.run(async () => {
    const complete = tool("full");
    expect(await complete.next()).toEqual({ value: 1, done: false });
    expect((await complete.next()).done).toBe(true);
    expect((await complete.next()).done).toBe(true);
    const sent = tool("sent");
    await sent.next();
    expect((await sent.next(2)).value).toBe(2);
    await sent.next();
    const thrown = tool("thrown");
    await thrown.next();
    expect((await thrown.throw(new Error("local"))).value).toBe(9);
    await thrown.next();
  });
  const p = await frozen(host, capture);
  await p.run(async () => {
    const stream = tool("full");
    expect((await stream.next()).value).toBe(1);
    expect((await stream.next()).done).toBe(true);
    reason(() => tool("sent"), "incomplete");
    reason(() => tool("thrown"), "incomplete");
  });
  await capture.flush();
  expect(capture.client.reserve(64 * 1024 * 1024)).toBe(true);
  capture.client.release(64 * 1024 * 1024);
});

test("tool, AI and MCP contract mismatches miss without selected live execution", async () => {
  const host = new Hosted(),
    capture = await host.capture();
  let live = 0;
  const source = wrapTool("docs", "search", (x: unknown) => {
    live++;
    return x;
  });
  capture.run(() => source({ q: "known" }));
  const p = await frozen(host, capture);
  const changed = wrapTool(
    "docs",
    "search",
    (x: unknown) => {
      live++;
      return x;
    },
    undefined,
    { contractVersion: "2" },
  );
  const tools = wrapAiTools(
    "docs",
    {
      search: {
        execute: async (_: unknown) => {
          live++;
          return 7;
        },
      },
    },
    { contractVersion: "2" },
  );
  const mcp = wrapMcpClient(
    "docs",
    {
      async callTool(_: unknown) {
        live++;
        return { content: [] };
      },
    },
    { contractVersion: "2" },
  );
  await p.run(async () => {
    reason(() => changed({ q: "known" }), "incompatible");
    await expect(tools.search.execute({ q: "known" })).rejects.toMatchObject({
      reason: "incompatible",
    });
    await expect(
      mcp.callTool({ name: "search", arguments: { q: "known" } }),
    ).rejects.toMatchObject({ reason: "incompatible" });
  });
  expect(live).toBe(1);
  expect(p.events.every((e) => e.reason === "incompatible")).toBe(true);
});

test("removing URL credentials preserves query spelling and duplicate ordering", async () => {
  const host = new Hosted(),
    capture = await host.capture();
  const source = wrapTool("docs", "search", (_: unknown) => "source");
  capture.run(() =>
    source({
      url: "https://source.test/files?q=a%20b&q=~&token=secret&last=%2f",
    }),
  );
  await capture.flush();
  const args = host.observations[0].arguments;
  expect(args).toEqual({
    kind: "json",
    value: { url: "https://source.test/files?q=a%20b&q=~&last=%2f" },
  });
  const p = await frozen(host, capture);
  expect(
    p.run(() =>
      source({
        url: "https://source.test/files?q=a%20b&q=~&token=new&last=%2f",
      }),
    ),
  ).toBe("source");
});

test("stream item metadata is bounded even for absent zero-byte values", async () => {
  const host = new Hosted(),
    capture = await host.capture();
  const source = wrapTool("docs", "search", async function* () {
    for (let n = 0; n < 2001; n++) yield undefined;
  });
  await capture.run(async () => {
    for await (const _ of source()) {
    }
  });
  const p = await frozen(host, capture);
  p.run(() => reason(() => source(), "incomplete"));
  expect(capture.client.reserve(64 * 1024 * 1024)).toBe(true);
  capture.client.release(64 * 1024 * 1024);
});

test("replay reporting exposes failures and retries completion with a stable key", async () => {
  const host = new Hosted();
  let reject = true;
  const completions: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/scene-replays/replay/complete")) {
      completions.push(String(init?.body));
      if (reject) {
        reject = false;
        return new Response(null, { status: 503 });
      }
    }
    return host.fetch(input, init);
  }) as unknown as typeof fetch;
  const capture = await CaptureSession.create(host.client({ fetch: fetcher }), {
    bindings: [binding],
    externalTraceId: "1".repeat(32),
  });
  const source = wrapTool("docs", "search", () => 1);
  capture.run(() => source());
  const p = await frozen(host, capture);
  p.run(() => source());
  const completion = p.complete();
  expect(() => p.run(() => source())).toThrow("dispatch is closed");
  expect(() => p.invoke("docs", "search", [], () => 7)).toThrow(
    "dispatch is closed",
  );
  expect(() => p.reject("docs", "search", [], "unrecorded")).toThrow(
    "dispatch is closed",
  );
  await expect(completion).rejects.toThrow();
  expect(p.diagnostics.deliveryOk).toBe(false);
  expect(() => p.run(() => source())).toThrow("dispatch is closed");
  await p.complete();
  expect(completions[0]).toBe(completions[1]);
  expect(p.diagnostics.deliveryOk).toBe(true);
  expect(() => p.run(() => source())).toThrow("dispatch is closed");
  expect(host.events).toHaveLength(1);
});

test("inline payload bounds and finish provenance reject malformed foreign snapshots", async () => {
  const host = new Hosted(),
    capture = await host.capture();
  const source = wrapTool("docs", "search", (): unknown => "original");
  capture.run(() => source());
  await capture.finalize();
  const original = host.manifest!;
  for (const kind of ["json", "bytes"] as const) {
    for (const oversized of [false, true]) {
      const manifest = structuredClone(original);
      const finish = manifest.observations.find((o) => o.phase === "finish")!;
      finish.result =
        kind === "json"
          ? { kind, value: "x".repeat(262144 - 2 + Number(oversized)) }
          : { kind, base64: "A".repeat(262144 + (oversized ? 4 : 0)) };
      const p = await Playback.fromManifest(capture.client, manifest, ["docs"]);
      if (oversized) p.run(() => reason(() => source(), "integrity"));
      else
        expect(p.run(() => source())).toEqual(
          kind === "json" ? "x".repeat(262142) : new Uint8Array(196608),
        );
    }
  }
  const malformed = structuredClone(original);
  malformed.observations.find((o) => o.phase === "finish")!.parentCallId =
    "other-call";
  await expect(
    Playback.fromManifest(capture.client, malformed, ["docs"]),
  ).rejects.toMatchObject({ reason: "integrity" });
});

test("shared schema admission fixtures reject malformed bindings and HTTP bodies", async () => {
  const host = new Hosted(),
    capture = await host.capture();
  const source = wrapTool("docs", "search", () => "original");
  capture.run(() => source());
  await capture.finalize();
  for (const fixture of fixtures.schemaCases) {
    const manifest = structuredClone(host.manifest!);
    if (fixture.definition === "binding") {
      manifest.bindings = [fixture.value as Binding];
      manifest.observations = [];
    } else if (fixture.definition === "observation") {
      manifest.observations = [
        { ...fixture.value, bindingId: "docs" } as Observation,
      ];
    } else {
      const finish = manifest.observations.find((o) => o.phase === "finish")!;
      finish.result = fixture.value as Observation["result"];
    }
    const pending = Playback.fromManifest(capture.client, manifest, ["docs"]);
    if (fixture.valid) expect((await pending).manifest.sceneId).toBe("scene");
    else await expect(pending).rejects.toMatchObject({ reason: "integrity" });
  }
});

test("HTTP reconstruction failures persist an explicit miss without an upstream call", async () => {
  const host = new Hosted(),
    capture = await host.capture([
      {
        id: "http",
        kind: "http",
        contractVersion: "1",
        http: { origin: "https://source.test", pathPrefix: "/" },
      },
    ]);
  let live = 0;
  const f = wrapFetch((async () => {
    live++;
    return new Response("original");
  }) as unknown as typeof fetch);
  await capture.run(async () => {
    await (await f("https://source.test/file")).text();
  });
  await capture.finalize();
  const manifest = structuredClone(host.manifest!);
  const result = manifest.observations.find(
    (o) => o.phase === "finish",
  )!.result!;
  if (result.kind !== "http") throw new Error("Expected HTTP response");
  result.headers["content-encoding"] = "unsupported-encoding";
  const p = await Playback.fromManifest(capture.client, manifest, ["http"]);
  await p.run(() =>
    expect(f("https://source.test/file")).rejects.toMatchObject({
      reason: "nonportable",
    }),
  );
  await p.complete();
  expect(p.events.map((e) => e.status)).toEqual(["matched", "miss"]);
  expect(p.events.at(-1)?.reason).toBe("nonportable");
  expect(host.events).toHaveLength(2);
  expect(live).toBe(1);
});

test("local MCP streams and malformed envelopes persist nonportable misses", async () => {
  const host = new Hosted(),
    capture = await host.capture([{ ...binding, kind: "mcp" }]);
  let live = 0;
  const source = wrapTool(
    "docs",
    "tools/call:search",
    ({ mode }: { mode: string }) => {
      live++;
      if (mode === "stream")
        return (async function* () {
          yield "item";
        })();
      if (mode === "absent") return undefined;
      return { content: "invalid" };
    },
  );
  const modes = ["stream", "absent", "malformed"];
  await capture.run(async () => {
    for (const mode of modes) {
      const value = source({ mode });
      if (mode === "stream")
        for await (const _ of value as AsyncIterable<unknown>) {
        }
    }
  });
  const p = await frozen(host, capture);
  const server = createPlaybackMcpServer(p, "docs");
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve(value: CallToolResult): void; reject(error: Error): void }
  >();
  transport.onmessage = (message) => {
    if (!("id" in message) || typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if ("result" in message) entry?.resolve(message.result as CallToolResult);
    else entry?.reject(new Error("Unexpected MCP protocol error"));
  };
  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<CallToolResult>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      void transport.send({ jsonrpc: "2.0", id, method, params }).catch(reject);
    });
  await server.connect(serverTransport);
  await transport.start();
  try {
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "synthetic", version: "1" },
    });
    await transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    for (const mode of modes) {
      const result = await call("tools/call", {
        name: "search",
        arguments: { mode },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe("text");
      if (result.content[0].type !== "text")
        throw new Error("Expected diagnostic text");
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: "HUE_SNAPSHOT_MISS",
        reason: "nonportable",
      });
    }
  } finally {
    await server.close();
    await transport.close();
  }
  await p.complete();
  expect(p.events.filter((e) => e.status === "miss")).toHaveLength(3);
  expect(host.events).toHaveLength(6);
  expect(live).toBe(3);
});

test("MCP extraction preserves original live validation and fails closed in selected playback", async () => {
  const host = new Hosted(),
    capture = await host.capture([{ ...binding, kind: "mcp" }]);
  const original = new Error("Original MCP client validation");
  let live = 0,
    accessed = 0;
  const mcp = wrapMcpClient("docs", {
    async callTool(_: unknown) {
      live++;
      throw original;
    },
  });
  const input = Object.defineProperty({}, "name", {
    get() {
      accessed++;
      throw new Error("Adapter extraction failure");
    },
  });
  await expect(mcp.callTool(input)).rejects.toBe(original);
  expect(accessed).toBe(0);
  await expect(capture.run(() => mcp.callTool(input))).rejects.toBe(original);
  expect(accessed).toBe(1);
  const p = await frozen(host, capture);
  await p.run(() =>
    expect(mcp.callTool(input)).rejects.toMatchObject({
      reason: "nonportable",
    }),
  );
  expect(live).toBe(2);
});

test("shared HTTP body fixtures and strict JSON media types preserve cross-language keys", async () => {
  const host = new Hosted(),
    capture = await host.capture([
      {
        id: "http",
        kind: "http",
        contractVersion: "1",
        http: { origin: "https://source.test", pathPrefix: "/" },
      },
    ]);
  let live = 0;
  const f = wrapFetch((async () => {
    live++;
    return new Response("source", {
      headers: { "content-type": "text/plain" },
    });
  }) as unknown as typeof fetch);
  const cases = [
    ...fixtures.httpBodies,
    ...[
      "application/jsonp",
      "x-application/json",
      "application/a+json-invalid",
      "text/plain; note=application/json",
    ].map((contentType) => ({
      contentType,
      body: '{ "a":1 }',
      sha256: hash('{ "a":1 }'),
    })),
    {
      contentType: "application/json",
      body: new Uint8Array([0x22, 0x80, 0x22]),
      sha256: null,
    },
    { contentType: "application/json", body: "9007199254740992", sha256: null },
  ];
  await capture.run(async () => {
    for (const [index, fixture] of cases.entries()) {
      await (
        await f(`https://source.test/${index}`, {
          method: "POST",
          body: fixture.body,
          headers: { "content-type": fixture.contentType },
        })
      ).text();
    }
  });
  await capture.flush();
  const starts = host.observations.filter((o) => o.phase === "start");
  for (const [index, fixture] of cases.entries()) {
    const args = starts[index].arguments;
    expect(args?.kind).toBe("json");
    if (args?.kind !== "json") throw new Error("Missing HTTP request evidence");
    if (fixture.sha256 === null) expect(starts[index].replayable).toBe(false);
    else
      expect((args.value as { bodySha256: string }).bodySha256).toBe(
        fixture.sha256,
      );
  }
  const p = await frozen(host, capture, ["http"]);
  await p.run(async () => {
    for (const [index, fixture] of cases.entries()) {
      const response = f(`https://source.test/${index}`, {
        method: "POST",
        body: fixture.body,
        headers: { "content-type": fixture.contentType },
      });
      if (fixture.sha256 === null)
        await expect(response).rejects.toMatchObject({ reason: "nonportable" });
      else expect(await (await response).text()).toBe("source");
    }
  });
  expect(live).toBe(cases.length);
});

test("fetch HEAD replay preserves null body and representation length without decoding absent bytes", async () => {
  const host = new Hosted(),
    capture = await host.capture([
      {
        id: "http",
        kind: "http",
        contractVersion: "1",
        http: { origin: "https://source.test", pathPrefix: "/" },
      },
    ]);
  let live = 0;
  const f = wrapFetch((async () => {
    live++;
    return new Response(null, {
      headers: {
        "content-type": "application/pdf",
        "content-encoding": "gzip",
        "content-length": "987",
      },
    });
  }) as unknown as typeof fetch);
  await capture.run(() => f("https://source.test/file", { method: "HEAD" }));
  const p = await frozen(host, capture, ["http"]);
  await p.run(async () => {
    const response = await f("https://source.test/file", { method: "HEAD" });
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("987");
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });
  expect(live).toBe(1);
});

test("a failed HTTP response stream retains the live prefix and cannot replay as an initial error", async () => {
  const host = new Hosted(),
    capture = await host.capture([
      {
        id: "http",
        kind: "http",
        contractVersion: "1",
        http: { origin: "https://source.test", pathPrefix: "/" },
      },
    ]);
  const original = new Error("Synthetic response read failed");
  let live = 0,
    reads = 0;
  const f = wrapFetch((async () => {
    live++;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (reads++ === 0) controller.enqueue(new Uint8Array([42]));
            else controller.error(original);
          },
        },
        { highWaterMark: 0 },
      ),
    );
  }) as unknown as typeof fetch);
  await capture.run(async () => {
    const response = await f("https://source.test/partial");
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([42]));
    await expect(reader.read()).rejects.toBe(original);
  });
  const p = await frozen(host, capture, ["http"]);
  await p.run(() =>
    expect(f("https://source.test/partial")).rejects.toMatchObject({
      reason: "incomplete",
    }),
  );
  expect(live).toBe(1);
});
