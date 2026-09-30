import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createHue, type HueClient } from "../src/index.js";
import { mergeIdentityBaggage, readIdentityBaggage } from "../src/propagation.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };
import fixture from "./fixtures/identity-baggage.json" with { type: "json" };

type Value = { stringValue?: string };
type Attribute = { key: string; value: Value };
type WireRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  attributes?: Attribute[];
};
const root = protobuf.Root.fromJSON(schema);
const apiKey = "synthetic-hue-propagation-key";
const world = "hue-world=0b7c2d4e-1f3a-4b5c-8d9e-0a1b2c3d4e5f";
const IDS = ["gen_ai.conversation.id", "user.id", "hue.workspace.id"] as const;

/** A loopback OTLP receiver that decodes the spans and log records each request carried. */
function receiver() {
  const spans: WireRecord[] = [];
  const logs: WireRecord[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const signal = new URL(request.url).pathname.endsWith("/logs") ? "logs" : "traces";
      const namespace = `opentelemetry.proto.collector.${signal === "traces" ? "trace" : "logs"}.v1.Export${signal === "traces" ? "Trace" : "Logs"}Service`;
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      const type = root.lookupType(`${namespace}Request`);
      const data = type.toObject(type.decode(bytes), { longs: String, bytes: String });
      if (signal === "traces")
        for (const group of data.resourceSpans ?? [])
          for (const scope of group.scopeSpans ?? []) spans.push(...(scope.spans ?? []));
      else
        for (const group of data.resourceLogs ?? [])
          for (const scope of group.scopeLogs ?? []) logs.push(...(scope.logRecords ?? []));
      const responseType = root.lookupType(`${namespace}Response`);
      return new Response(new Uint8Array(responseType.encode(responseType.create({})).finish()), {
        headers: { "content-type": "application/x-protobuf" },
      });
    },
  });
  return { server, spans, logs, url: `http://127.0.0.1:${server.port}` };
}

function attr(record: WireRecord | undefined, key: string): string | undefined {
  return record?.attributes?.find((item) => item.key === key)?.value.stringValue;
}

function identityOf(record: WireRecord | undefined) {
  return IDS.map((key) => attr(record, key));
}

const hex = (id: string | undefined) => Buffer.from(id ?? "", "base64").toString("hex");

async function withHue<T>(
  run: (hue: HueClient, endpoint: ReturnType<typeof receiver>) => Promise<T>,
  captureContent = false,
): Promise<T> {
  const endpoint = receiver();
  const hue = createHue({
    apiKey,
    serviceName: "propagation",
    captureContent,
    baseUrl: endpoint.url,
  });
  try {
    return await run(hue, endpoint);
  } finally {
    await hue.shutdownSafe();
    endpoint.server.stop(true);
  }
}

const traceparent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;

describe("identity propagation", () => {
  test("default inject and extract ignore identity and baggage", async () => {
    await withHue(async (hue, endpoint) => {
      const carrier: Record<string, string> = {};
      const forged: Record<string, string> = { baggage: "hue.user.id=forged" };
      await hue.withSpan(
        "producer",
        () => {
          hue.inject(carrier);
          hue.inject(forged);
        },
        { sessionId: "s", userId: "u", workspaceId: "w" },
      );
      expect(Object.keys(carrier)).toEqual(["traceparent"]);
      expect(forged.baggage).toBe("hue.user.id=forged");
      const parentContext = hue.extract({ traceparent, baggage: "hue.user.id=forged" });
      await hue.withSpan("consumer", () => hue.withSpan("nested", () => undefined), {
        parentContext,
      });
      await hue.flush();
      for (const name of ["consumer", "nested"])
        expect(identityOf(endpoint.spans.find((span) => span.name === name))).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
    });
  });

  test("identity travels through baggage when both sides opt in", async () => {
    await withHue(async (hue, endpoint) => {
      const ids = fixture.encode[0]!.identity;
      const carrier: Record<string, string> = {};
      let producerSpanId = "";
      await hue.withSpan(
        "producer",
        (span) => {
          producerSpanId = span.spanId;
          hue.inject(carrier, { identity: true });
        },
        ids,
      );
      expect(carrier.baggage).toBe(fixture.encode[0]!.expected!);
      expect(carrier.traceparent).toContain(producerSpanId);
      expect(JSON.stringify(carrier)).not.toContain(apiKey);
      // A separate client stands in for the worker process.
      const parentContext = hue.extract(carrier, { identity: true });
      await hue.withSpan(
        "consumer",
        async () => {
          await hue.model(
            "synthetic-model",
            () => hue.recordMessages({ output: [{ role: "assistant", parts: [] }] }),
            { provider: "synthetic" },
          );
          await hue.tool("lookup", null, () => null);
          hue.tracer.startSpan("third-party").end();
        },
        { parentContext },
      );
      await hue.flush();
      const byName = (name: string) => endpoint.spans.find((span) => span.name === name)!;
      const producer = byName("producer");
      const consumer = byName("consumer");
      expect(consumer.traceId).toBe(producer.traceId);
      expect(consumer.parentSpanId).toBe(producer.spanId);
      for (const name of ["consumer", "chat synthetic-model", "execute_tool lookup", "third-party"])
        expect(identityOf(byName(name))).toEqual([ids.sessionId, ids.userId, ids.workspaceId]);
      expect(endpoint.logs).toHaveLength(1);
      expect(attr(endpoint.logs[0], "gen_ai.conversation.id")).toBe(ids.sessionId);
      expect(hue.transport.getReport().instrumentationFailures).toBe(0);
    }, true);
  });

  test("inject always owns the hue identity members", async () => {
    await withHue(async (hue) => {
      const inject = (carrier: Record<string, string>, ids = {}) =>
        hue.withSpan("s", () => hue.inject(carrier, { identity: true }), ids);
      const kept: Record<string, string> = { baggage: `${world}, app=a%2Cb;p=1` };
      await inject(kept, { sessionId: "s" });
      expect(kept.baggage).toBe(`${world}, app=a%2Cb;p=1,hue.session.id=s`);
      const stale: Record<string, string> = { baggage: "hue.user.id=old,app=1" };
      await inject(stale, { userId: "new" });
      expect(stale.baggage).toBe("app=1,hue.user.id=new");
      const forged: Record<string, string> = {
        baggage: "hue-world=w,hue.user.id=forged,hue.workspace.id=evil",
      };
      await inject(forged);
      expect(forged.baggage).toBe("hue-world=w");
      const only: Record<string, string> = { baggage: "hue.session.id=forged" };
      await inject(only);
      expect(Object.keys(only)).toEqual(["traceparent"]);
      const capitalized: Record<string, string> = { Baggage: "app=1" };
      await inject(capitalized, { userId: "u" });
      expect(capitalized).toEqual({
        traceparent: capitalized.traceparent!,
        Baggage: "app=1,hue.user.id=u",
      });
      const otherCase: Record<string, string> = { baggage: "HUE.USER.ID=x" };
      await inject(otherCase, { userId: "u" });
      expect(otherCase.baggage).toBe("HUE.USER.ID=x,hue.user.id=u");
      // Outside any helper and without an extracted context there is no identity to write.
      const outside: Record<string, string> = { baggage: "app=1,hue.user.id=forged" };
      hue.inject(outside, { identity: true });
      expect(outside.baggage).toBe("app=1");
      expect(hue.transport.getReport().instrumentationFailures).toBe(0);
    });
  });

  test("the shared fixture encodes and decodes identically in both SDKs", async () => {
    for (const item of fixture.encode) {
      const result = mergeIdentityBaggage(item.existing ?? undefined, item.identity);
      expect(result.value ?? null, item.name).toBe(item.expected);
      expect(result.ownMemberTooLong, item.name).toBe(item.omittedTooLong);
      // Every written identity reads back as the valid identifiers it was given.
      if (item.expected !== null && item.omittedTooLong === 0) {
        const valid = Object.fromEntries(
          Object.entries(item.identity).filter(
            ([, value]) => value !== "" && !value.includes("\u0000"),
          ),
        );
        expect(readIdentityBaggage(item.expected) ?? {}, item.name).toEqual(valid);
      }
    }
    for (const item of fixture.decode)
      expect(readIdentityBaggage(item.header) ?? null, item.name).toEqual(item.identity);
    // Through the client: a decoded identity is re-encoded byte for byte.
    await withHue(async (hue) => {
      const out: Record<string, string> = {};
      hue.inject(out, {
        context: hue.extract(
          { traceparent, baggage: fixture.encode[1]!.expected! },
          { identity: true },
        ),
        identity: true,
      });
      expect(out.baggage).toBe(fixture.encode[1]!.expected!);
    });
  });

  test("explicit identifiers win, remote beats inherited per field, local contexts are not remote", async () => {
    await withHue(async (hue, endpoint) => {
      const remote = hue.extract(
        { traceparent, baggage: "hue.session.id=remote,hue.user.id=ru" },
        { identity: true },
      );
      let local = ROOT_CONTEXT;
      await hue.withSpan(
        "outer",
        async () => {
          await hue.withSpan("joined", () => hue.withSpan("joined-child", () => undefined), {
            parentContext: remote,
            userId: "explicit",
          });
          await hue.withSpan("sibling", (span) => {
            local = span.context;
          });
          await hue.withSpan("local-parent", () => undefined, { parentContext: local });
          const span = hue.tracer.startSpan("tracer-remote", {}, remote);
          span.end();
          hue.tracer.startActiveSpan("active-remote", {}, remote, (active) => {
            hue.tracer.startSpan("active-remote-child").end();
            hue.recordMessages({ output: [{ role: "assistant", parts: [] }] });
            active.end();
          });
        },
        { sessionId: "outer", workspaceId: "w-outer" },
      );
      await hue.flush();
      const byName = (name: string) => endpoint.spans.find((span) => span.name === name);
      expect(identityOf(byName("joined"))).toEqual(["remote", "explicit", "w-outer"]);
      expect(identityOf(byName("joined-child"))).toEqual(["remote", "explicit", "w-outer"]);
      expect(identityOf(byName("local-parent"))).toEqual(["outer", undefined, "w-outer"]);
      expect(identityOf(byName("tracer-remote"))).toEqual(["remote", "ru", "w-outer"]);
      expect(identityOf(byName("active-remote"))).toEqual(["remote", "ru", "w-outer"]);
      expect(identityOf(byName("active-remote-child"))).toEqual(["remote", "ru", "w-outer"]);
      expect(byName("joined")!.traceId).toBe(Buffer.from("a".repeat(32), "hex").toString("base64"));
      // A record inside startActiveSpan takes the session from the scope it opened.
      expect(endpoint.logs.map((log) => attr(log, "gen_ai.conversation.id"))).toEqual(["remote"]);
    }, true);
  });

  test("extract treats baggage as untrusted", async () => {
    await withHue(async (hue, endpoint) => {
      const members = (count: number) =>
        Array.from({ length: count }, (_, index) => `m${index}=v`).join(",");
      const refused = [
        "hue.session.id=%zz",
        "hue.session.id=%C3%28",
        "hue.session.id=%00",
        "hue.session.id=é",
        `hue.session.id=${"a".repeat(4097)}`,
        "hue.session.id=a,hue.session.id=b",
        `hue.session.id=s,pad=${"p".repeat(8192 - "hue.session.id=s,pad=".length + 1)}`,
        `hue.session.id=s,${members(180)}`,
        "HUE.SESSION.ID=s",
        "hue.session.id=",
      ];
      expect(Buffer.byteLength(refused[6]!)).toBe(8193);
      for (const baggage of refused)
        await hue.withSpan("refused", () => undefined, {
          parentContext: hue.extract({ traceparent, baggage }, { identity: true }),
        });
      // Exactly at the bounds, with optional whitespace and properties, the member is read.
      const accepted = [
        " hue.session.id = s ;p=1 ",
        `hue.session.id=s,pad=${"p".repeat(8192 - "hue.session.id=s,pad=".length)}`,
        `hue.session.id=s,${members(179)}`,
        ["app=1", "hue.session.id=s"],
      ];
      for (const baggage of accepted)
        await hue.withSpan("accepted", () => undefined, {
          parentContext: hue.extract({ traceparent, baggage }, { identity: true }),
        });
      await hue.flush();
      const named = (name: string) => endpoint.spans.filter((span) => span.name === name);
      expect(named("refused")).toHaveLength(refused.length);
      for (const span of named("refused"))
        expect(attr(span, "gen_ai.conversation.id")).toBeUndefined();
      expect(named("accepted").map((span) => attr(span, "gen_ai.conversation.id"))).toEqual(
        accepted.map(() => "s"),
      );
      expect(hue.transport.getReport().instrumentationFailures).toBe(0);
      expect((await hue.flush()).instrumentationFailures).toBe(0);
    });
  });

  test("inject stays within baggage bounds without counting remote crowding", async () => {
    await withHue(async (hue) => {
      const long: Record<string, string> = {};
      await hue.withSpan("long", () => hue.inject(long, { identity: true }), {
        sessionId: "s",
        workspaceId: "w".repeat(4080),
      });
      expect(long.traceparent).toBeDefined();
      expect(long.baggage).toBe("hue.session.id=s");
      expect(hue.transport.getReport().instrumentationFailures).toBe(1);
      await expect(hue.flush()).rejects.toThrow();
    });
    await withHue(async (hue) => {
      const others = Array.from({ length: 62 }, (_, index) => `m${index}=v${index}`);
      const crowded: Record<string, string> = {
        baggage: [...others.slice(0, 31), "hue.user.id=forged", ...others.slice(31)].join(","),
      };
      await hue.withSpan("crowded", () => hue.inject(crowded, { identity: true }), {
        sessionId: "s",
        userId: "u",
        workspaceId: "w",
      });
      expect(crowded.traceparent).toBeDefined();
      // 62 kept members plus three Hue members would pass 64: only the forged member goes.
      expect(crowded.baggage).toBe(others.join(","));
      const large: Record<string, string> = { baggage: `app=${"x".repeat(8180)}` };
      await hue.withSpan("large", () => hue.inject(large, { identity: true }), { sessionId: "s" });
      expect(large.baggage).toBe(`app=${"x".repeat(8180)}`);
      expect(hue.transport.getReport().instrumentationFailures).toBe(0);
      expect((await hue.flush()).instrumentationFailures).toBe(0);
    });
  });

  test("disabled clients propagate traceparent and relay only an explicit identity context", async () => {
    const hue = createHue({ enabled: false });
    const extracted = hue.extract(
      { traceparent, baggage: "hue.session.id=s,hue.user.id=u" },
      { identity: true },
    );
    const relayed: Record<string, string> = { baggage: world };
    hue.inject(relayed, { context: extracted, identity: true });
    expect(relayed).toEqual({ traceparent, baggage: `${world},hue.session.id=s,hue.user.id=u` });
    const helper: Record<string, string> = { baggage: `${world},hue.user.id=forged` };
    await hue.withSpan("off", () => hue.inject(helper, { identity: true }), {
      sessionId: "local",
      parentContext: extracted,
    });
    expect(helper).toEqual({ baggage: world });
    const plain: Record<string, string> = {};
    hue.inject(plain, extracted);
    expect(plain).toEqual({ traceparent });
    expect(hue.transport.getReport().instrumentationFailures).toBe(0);
    expect((await hue.shutdownSafe()).ok).toBe(true);
  });

  test("identity crosses a real process boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hue-propagation-"));
    try {
      await withHue(async (hue, endpoint) => {
        const script = join(directory, "worker.mjs");
        await writeFile(
          script,
          `import { createHue } from ${JSON.stringify(import.meta.resolve("../src/index.js"))};
const hue = createHue({ apiKey: process.env.HUE_API_KEY, serviceName: "worker", captureContent: false, baseUrl: process.env.HUE_BASE_URL });
const parentContext = hue.extract({ traceparent: process.env.TRACEPARENT, baggage: process.env.BAGGAGE }, { identity: true });
await hue.withSpan("worker", () => undefined, { parentContext });
const report = await hue.shutdown();
process.stdout.write(JSON.stringify({ baggage: process.env.BAGGAGE, exported: report.acceptedSpans }));
`,
        );
        // The orchestrator seeds its carrier from an inherited BAGGAGE so hue-world survives.
        const carrier: Record<string, string> = { baggage: world };
        await hue.withSpan("orchestrator", () => hue.inject(carrier, { identity: true }), {
          sessionId: "slack:T1:C1:1712.5",
          userId: "org_1:U9",
          workspaceId: "T1",
        });
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [script], {
            env: {
              PATH: process.env.PATH,
              HUE_API_KEY: apiKey,
              HUE_BASE_URL: endpoint.url,
              TRACEPARENT: carrier.traceparent,
              BAGGAGE: carrier.baggage,
            },
            stdio: ["ignore", "pipe", "inherit"],
          });
          let stdout = "";
          child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0 ? resolve(stdout) : reject(new Error(`worker exited with ${code}`)),
          );
        });
        const received = JSON.parse(output) as { baggage: string; exported: number };
        expect(received.baggage.startsWith(`${world},`)).toBe(true);
        expect(received.exported).toBe(1);
        await hue.flush();
        const orchestrator = endpoint.spans.find((span) => span.name === "orchestrator")!;
        const worker = endpoint.spans.find((span) => span.name === "worker")!;
        expect(worker.traceId).toBe(orchestrator.traceId);
        expect(hex(worker.parentSpanId)).toBe(hex(orchestrator.spanId));
        expect(identityOf(worker)).toEqual(["slack:T1:C1:1712.5", "org_1:U9", "T1"]);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the active extracted context applies identity when a context manager is registered", async () => {
    await withHue(async (hue, endpoint) => {
      const inbound = { traceparent, baggage: "hue.session.id=remote,hue.user.id=ru" };
      // Without a registered context manager context.with is a no-op: nothing is applied.
      await context.with(hue.extract(inbound, { identity: true }), () =>
        hue.withSpan("unmanaged", () => undefined),
      );
      const manager = new AsyncLocalStorageContextManager().enable();
      expect(context.setGlobalContextManager(manager)).toBe(true);
      const relayed: Record<string, string> = {};
      try {
        await context.with(hue.extract(inbound, { identity: true }), async () => {
          const outside: Record<string, string> = {};
          hue.inject(outside, { identity: true });
          expect(outside.baggage).toBe("hue.session.id=remote,hue.user.id=ru");
          await hue.withSpan("managed", async () => {
            hue.inject(relayed, { identity: true });
            await hue.withSpan("managed-child", () => undefined);
          });
          await hue.withSpan("managed-explicit", () => undefined, { sessionId: "explicit" });
        });
      } finally {
        context.disable();
      }
      expect(relayed.baggage).toBe("hue.session.id=remote,hue.user.id=ru");
      await hue.flush();
      const byName = (name: string) => endpoint.spans.find((span) => span.name === name);
      expect(identityOf(byName("unmanaged"))).toEqual([undefined, undefined, undefined]);
      expect(identityOf(byName("managed"))).toEqual(["remote", "ru", undefined]);
      expect(identityOf(byName("managed-child"))).toEqual(["remote", "ru", undefined]);
      expect(identityOf(byName("managed-explicit"))).toEqual(["explicit", "ru", undefined]);
    });
  });

  test("inject overload tells a Context from options", async () => {
    await withHue(async (hue) => {
      const extracted = hue.extract(
        { traceparent, baggage: "hue.session.id=s" },
        { identity: true },
      );
      const derived = trace.setSpanContext(extracted, trace.getSpanContext(extracted)!);
      const positional: Record<string, string> = {};
      hue.inject(positional, derived);
      expect(positional).toEqual({ traceparent });
      const options: Record<string, string> = {};
      hue.inject(options, { context: derived, identity: true });
      expect(options).toEqual({ traceparent, baggage: "hue.session.id=s" });
      const off: Record<string, string> = {};
      hue.inject(off, { context: derived, identity: false });
      expect(off).toEqual({ traceparent });
      // A mistyped opt-in is off and counted, as is a carrier value that is not a string.
      const mistyped: Record<string, string> = {};
      hue.inject(mistyped, { context: derived, identity: "yes" as never });
      expect(mistyped).toEqual({ traceparent });
      const wrong = { baggage: 42 } as unknown as Record<string, string>;
      hue.inject(wrong, { context: derived, identity: true });
      expect(wrong).toEqual({ baggage: 42, traceparent } as never);
      expect(hue.transport.getReport().instrumentationFailures).toBe(2);
      await hue.flush().catch(() => undefined);
    });
  });
});
