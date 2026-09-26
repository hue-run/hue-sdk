import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { lookup } from "node:dns";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  forwardDelivery,
  isLoopbackAddress,
  LISTEN_USAGE,
  parseDelivery,
  parseForwardTarget,
  runListenCommand,
  type ListenCommandIo,
} from "../src/cli/listen.js";

// A synthetic stand-in for Hue's listen routes, written from the published contract: pull leases
// due deliveries to the credential that scopes the subscription, one open pull at a time, and an
// acknowledgement is accepted only from that credential, inside the lease, in the strict shape.

const cli = join(import.meta.dir, "../src/setup/cli.ts");
const SUBSCRIPTION = "5b0f6a52-3c1e-4d7a-9e55-0c2b8f1d9a11";
const WORLD_TOKEN = `hue_world_eyJ3b3JsZCI6InN5bnRoZXRpYyJ9.${"t".repeat(43)}`;
const CONNECTION_KEY = `hue_sk_test_abcd1234_${"c".repeat(40)}`;
const PROJECT_KEY = `hue_sk_test_proj5678_${"p".repeat(40)}`;
const SIGNING_SECRET = `hue_ss_${"s".repeat(43)}`;
const VERIFICATION_TOKEN = `hue_vt_${"v".repeat(43)}`;
const BODY_CANARY = "body-canary-never-logged";
const LEASE_MS = 30_000;
const ACK_FIELDS = new Set(["outcome", "status", "durationMs", "noRetry", "body"]);

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

async function listenOn(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return (server.address() as AddressInfo).port;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((done, failed) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => done(Buffer.concat(chunks)));
    request.on("error", failed);
  });
}

function sign(body: string, timestamp: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

interface Queued {
  deliveryId: string;
  kind: "url_verification" | "event_callback";
  eventId: string | null;
  retryNum: number;
  headers: Record<string, string>;
  body: string;
}

/** A delivery as Hue queues it: the compact body and every header Slack sends, signed. */
function slackDelivery(kind: Queued["kind"], options: { retryNum?: number; text?: string } = {}) {
  const retryNum = options.retryNum ?? 0;
  const eventId =
    kind === "event_callback"
      ? `Ev${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`
      : null;
  const body =
    kind === "url_verification"
      ? JSON.stringify({ token: VERIFICATION_TOKEN, challenge: "challenge-3eZbrw1aBm", type: kind })
      : JSON.stringify({
          token: VERIFICATION_TOKEN,
          team_id: "T0SYNTHETIC",
          api_app_id: "A0SYNTHETIC",
          event: {
            type: "app_mention",
            user: "U0SYNTHETIC",
            text: options.text ?? `<@U0BOT> what does it cost? ${BODY_CANARY} “quoted” ✓`,
            ts: "1790000000.000100",
            channel: "C0SYNTHETIC",
          },
          type: kind,
          event_id: eventId,
          event_time: 1790000000,
        });
  const timestamp = "1790000000";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Slackbot 1.0 (+https://api.slack.com/robots)",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": sign(body, timestamp),
  };
  if (retryNum) {
    headers["x-slack-retry-num"] = String(retryNum);
    headers["x-slack-retry-reason"] = "http_timeout";
  }
  return { deliveryId: randomUUID(), kind, eventId, retryNum, headers, body } satisfies Queued;
}

/** A queued delivery as a pull answer carries it. */
function wire(delivery: Queued, expiresAt = Date.now() + LEASE_MS) {
  return {
    deliveryId: delivery.deliveryId,
    subscriptionId: SUBSCRIPTION,
    worldId: "7d7c3f0e-2b4e-4a51-8a4c-3a1f5e2d6b70",
    eventId: delivery.eventId,
    kind: delivery.kind,
    retryNum: delivery.retryNum,
    leaseExpiresAt: new Date(expiresAt).toISOString(),
    request: { method: "POST", headers: delivery.headers, body: delivery.body },
  };
}

interface MockOptions {
  credential?: string;
  mode?: "listen" | "http";
  revoked?: boolean;
  /** Answer the first pulls with 409 pull_in_progress. */
  busyPulls?: number;
  /** Answer the first acknowledgements with 503. */
  ackFailures?: number;
  leaseMs?: number;
  /** Hand the same leased delivery out again in the next pull answer. */
  repeatDeliveries?: boolean;
  /** Answer the first pulls with 503 and `Retry-After: 0`. */
  pullFailures?: number;
  /** Lease every queued delivery, ignoring the pull's `max`. */
  overfill?: boolean;
}

interface RecordedAck {
  at: number;
  deliveryId: string;
  status: number;
  body: Record<string, unknown>;
}

/** Hue's listen routes, from the contract. */
async function mockHue(options: MockOptions = {}) {
  const credential = options.credential ?? WORLD_TOKEN;
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const queue: Queued[] = [];
  const leases = new Map<
    string,
    { delivery: Queued; credential: string; expiresAt: number; ack?: string; answer?: unknown }
  >();
  const pulls: Array<{ at: number; waitMs: number; max: number; closedEarly: boolean }> = [];
  const acks: RecordedAck[] = [];
  const refusals: Array<{ route: string; status: number }> = [];
  const repeat: Queued[] = [];
  let open = false;
  let busy = options.busyPulls ?? 0;
  let ackFailures = options.ackFailures ?? 0;
  let pullFailures = options.pullFailures ?? 0;
  const pullAttempts: number[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const raw = (await readBody(request)).toString("utf8");
      const send = (
        status: number,
        body: unknown,
        diagnostic?: string,
        headers: Record<string, string> = {},
      ) => {
        if (diagnostic) refusals.push({ route: request.url ?? "", status });
        response.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...(diagnostic ? { "x-hue-diagnostic": diagnostic } : {}),
          // A transient refusal asks for an immediate retry, which the client must not take.
          ...(status === 503 ? { "retry-after": "0" } : {}),
          ...headers,
        });
        response.end(JSON.stringify(diagnostic ? { error: "refused", diagnostic } : body));
      };
      const pull = /^\/api\/v1\/event-subscriptions\/([^/]+)\/deliveries\/pull$/u.exec(
        request.url ?? "",
      );
      const ack = /^\/api\/v1\/event-subscriptions\/([^/]+)\/deliveries\/([^/]+)\/ack$/u.exec(
        request.url ?? "",
      );
      const bearer = request.headers.authorization;
      if (request.method !== "POST" || (!pull && !ack)) return send(404, {}, "not_found");
      if (pull) {
        pullAttempts.push(Date.now());
        if (pullFailures > 0) {
          pullFailures--;
          return send(503, {}, "unavailable");
        }
        if (bearer !== `Bearer ${credential}`) return send(401, {}, "credential_not_subscription");
        if (pull[1] !== SUBSCRIPTION) return send(404, {}, "subscription_not_found");
        if (options.mode === "http") return send(409, {}, "not_listen");
        if (options.revoked) return send(409, {}, "subscription_revoked");
        if (busy > 0) {
          busy--;
          return send(409, {}, "pull_in_progress");
        }
        if (open) return send(409, {}, "pull_in_progress");
        let parsed: Record<string, unknown>;
        try {
          parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          return send(400, {}, "invalid_body");
        }
        const waitMs = parsed.waitMs ?? 0;
        const max = parsed.max ?? 1;
        if (
          Object.keys(parsed).some((key) => key !== "waitMs" && key !== "max") ||
          !Number.isInteger(waitMs) ||
          (waitMs as number) < 0 ||
          (waitMs as number) > 20_000 ||
          !Number.isInteger(max) ||
          (max as number) < 1 ||
          (max as number) > 10
        )
          return send(400, {}, "invalid_body");
        open = true;
        const entry = {
          at: Date.now(),
          waitMs: waitMs as number,
          max: max as number,
          closedEarly: false,
        };
        pulls.push(entry);
        let closed = false;
        response.on("close", () => {
          if (!response.writableEnded) {
            closed = true;
            entry.closedEarly = true;
          }
        });
        const deadline = Date.now() + (waitMs as number);
        while (!closed && queue.length === 0 && repeat.length === 0 && Date.now() < deadline)
          await new Promise((tick) => setTimeout(tick, 10));
        open = false;
        if (closed) return;
        const leased = [
          ...repeat.splice(0),
          ...queue.splice(0, options.overfill ? queue.length : (max as number)),
        ];
        // The answer's Date is whole seconds, as HTTP writes it; the lease is measured from it.
        const second = Math.floor(Date.now() / 1000) * 1000;
        const expiresAt = second + leaseMs;
        for (const delivery of leased) {
          if (!leases.has(delivery.deliveryId))
            leases.set(delivery.deliveryId, { delivery, credential, expiresAt });
          if (options.repeatDeliveries && !leases.get(delivery.deliveryId)!.ack)
            repeat.push(delivery);
        }
        return send(
          200,
          { deliveries: leased.map((delivery) => wire(delivery, expiresAt)) },
          undefined,
          { date: new Date(second).toUTCString() },
        );
      }
      const lease = leases.get(ack![2]!);
      if (ack![1] !== SUBSCRIPTION || !lease) return send(404, {}, "delivery_not_found");
      if (bearer !== `Bearer ${lease.credential}`)
        return send(401, {}, "credential_not_subscription");
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return send(400, {}, "invalid_body");
      }
      const { outcome, status, durationMs, noRetry, body: answer } = body;
      if (
        Object.keys(body).some((key) => !ACK_FIELDS.has(key)) ||
        !["response", "timeout", "connection_failed", "tls_error"].includes(outcome as string) ||
        (outcome === "response"
          ? !Number.isInteger(status) || (status as number) < 100 || (status as number) > 599
          : status !== undefined && status !== null) ||
        !Number.isInteger(durationMs) ||
        (durationMs as number) < 0 ||
        (durationMs as number) > LEASE_MS ||
        (noRetry !== undefined && typeof noRetry !== "boolean") ||
        (answer !== undefined &&
          answer !== null &&
          (typeof answer !== "string" || Buffer.byteLength(answer) > 4096))
      )
        return send(400, {}, "invalid_body");
      acks.push({ at: Date.now(), deliveryId: ack![2]!, status: 0, body });
      if (ackFailures > 0) {
        ackFailures--;
        acks.at(-1)!.status = 503;
        return send(503, {}, "unavailable");
      }
      if (Date.now() > lease.expiresAt) {
        acks.at(-1)!.status = 409;
        return send(409, {}, "lease_expired");
      }
      if (lease.ack !== undefined) {
        acks.at(-1)!.status = lease.ack === raw ? 200 : 409;
        return lease.ack === raw ? send(200, lease.answer) : send(409, {}, "ack_conflict");
      }
      const acknowledged =
        outcome === "response" &&
        (status as number) >= 200 &&
        (status as number) <= 299 &&
        (durationMs as number) <= 3000;
      lease.ack = raw;
      lease.answer = {
        state: acknowledged ? "acknowledged" : "pending",
        nextAttemptAt: acknowledged ? null : new Date(Date.now() + 1000).toISOString(),
      };
      acks.at(-1)!.status = 200;
      return send(200, lease.answer);
    })();
  });
  const port = await listenOn(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    queue,
    pulls,
    acks,
    refusals,
    pullAttempts,
    isPullOpen: () => open,
  };
}

interface Received {
  at: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
  method: string;
  url: string;
}

/** The developer's bot: records each request and answers through `answer`. */
async function receiver(
  answer: (request: Received, response: ServerResponse) => void | Promise<void> = (
    request,
    response,
  ) => {
    const parsed = JSON.parse(request.body.toString("utf8")) as {
      type: string;
      challenge?: string;
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      parsed.type === "url_verification" ? JSON.stringify({ challenge: parsed.challenge }) : "",
    );
  },
) {
  const requests: Received[] = [];
  const answered: number[] = [];
  let concurrent = 0;
  let peak = 0;
  const server = createServer((request, response) => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    response.on("close", () => {
      concurrent--;
      answered.push(Date.now());
    });
    void readBody(request).then((body) => {
      const received = {
        at: Date.now(),
        headers: request.headers,
        body,
        method: request.method ?? "",
        url: request.url ?? "",
      };
      requests.push(received);
      return answer(received, response);
    });
  });
  const port = await listenOn(server);
  return {
    port,
    url: `http://localhost:${port}/slack/events`,
    requests,
    answered,
    peak: () => peak,
  };
}

function collector() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/** Runs the command in process; `stop()` stands in for Ctrl+C. */
function run(argv: string[], env: Record<string, string>, io: Partial<ListenCommandIo> = {}) {
  const stdout = collector();
  const stderr = collector();
  let interrupt: (() => void) | undefined;
  const requests: string[] = [];
  const exit = runListenCommand(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env,
    cwd: import.meta.dir,
    retryDelaysMs: [20, 40, 80],
    fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(String(input));
      return fetch(input, init);
    }) as typeof fetch,
    onInterrupt: (listener) => {
      interrupt = listener;
      return () => {
        interrupt = undefined;
      };
    },
    ...io,
  });
  return {
    exit,
    stop: () => interrupt?.(),
    stdout: stdout.text,
    stderr: stderr.text,
    requests,
    output: () => stdout.text() + stderr.text(),
  };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await new Promise((tick) => setTimeout(tick, 10));
  }
}

const args = (origin: string, forwardTo: string, ...extra: string[]) => [
  "listen",
  "--subscription",
  SUBSCRIPTION,
  "--forward-to",
  forwardTo,
  "--origin",
  origin,
  ...extra,
];

describe("hue listen arguments", () => {
  test("names this machine as the only default destination", () => {
    for (const address of [
      "127.0.0.1",
      "127.8.9.10",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
    ])
      expect(isLoopbackAddress(address)).toBe(true);
    for (const address of [
      "10.0.0.1",
      "169.254.169.254",
      "0.0.0.0",
      "::",
      "::ffff:10.0.0.1",
      "fe80::1",
      "localhost",
      "128.0.0.1",
    ])
      expect(isLoopbackAddress(address)).toBe(false);
    for (const url of [
      "http://localhost:3000/slack/events",
      "http://127.0.0.1:3000/",
      "http://[::1]:3000/x",
      "https://bot.localhost/events",
      "http://LOCALHOST./events",
    ])
      expect(parseForwardTarget(url, false)).toBeInstanceOf(URL);
    for (const url of [
      "http://example.com/events",
      "http://10.0.0.5/events",
      "http://169.254.169.254/latest",
      "http://0.0.0.0:3000/",
      "http://localhost.example.com/",
    ])
      expect(parseForwardTarget(url, false)).toContain("--allow-remote-forward");
    expect(parseForwardTarget("http://example.com/events", true)).toBeInstanceOf(URL);
    expect(parseForwardTarget("http://user:pass@localhost:3000/", true)).toContain("credentials");
    expect(parseForwardTarget("http://localhost:3000/#x", false)).toContain("fragment");
    expect(parseForwardTarget("ftp://localhost/", false)).toContain("http or https");
    expect(parseForwardTarget("localhost:3000", false)).toContain("http or https");
  });

  test("refuses a project key, a missing or misplaced credential and a remote target before any request", async () => {
    const hue = await mockHue();
    const bot = await receiver();
    const cases: Array<{ env: Record<string, string>; argv?: string[]; message: string }> = [
      {
        env: { HUE_CONNECTION_KEY: PROJECT_KEY, HUE_API_KEY: PROJECT_KEY },
        message: "holds the project key in HUE_API_KEY",
      },
      {
        env: { HUE_CONNECTION_KEY: PROJECT_KEY, HUE_MCP_KEY: PROJECT_KEY },
        message: "holds the project key in HUE_MCP_KEY",
      },
      { env: { HUE_API_KEY: PROJECT_KEY }, message: "never uses a project key" },
      {
        // A token pasted as an argument or a path is not echoed back.
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        argv: [...args(hue.origin, bot.url), CONNECTION_KEY],
        message: "Unexpected argument: [redacted]",
      },
      {
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        argv: [...args(hue.origin, bot.url), "--env-path", `/tmp/${WORLD_TOKEN}`],
        message: "Unable to load /tmp/[redacted]",
      },
      { env: { HUE_WORLD_TOKEN: CONNECTION_KEY }, message: "holds a key, not a world token" },
      { env: { HUE_CONNECTION_KEY: WORLD_TOKEN }, message: "holds a world token" },
      { env: { HUE_WORLD_TOKEN: `hue_at_${"a".repeat(40)}` }, message: "is not a world token" },
      {
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN, HUE_CONNECTION_KEY: CONNECTION_KEY },
        message: "pass --credential",
      },
      {
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        argv: args(hue.origin, "http://example.com/events"),
        message: "--allow-remote-forward",
      },
      {
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        argv: args("http://hue.example", bot.url),
        message: "--origin must be an HTTPS origin",
      },
      {
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        argv: ["listen", "--subscription", "not-a-uuid", "--forward-to", bot.url],
        message: "--subscription must be",
      },
      {
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        argv: [...args(hue.origin, bot.url), "--max", "11"],
        message: "--max must be an integer from 1 to 10",
      },
      {
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        argv: [...args(hue.origin, bot.url), "--world-token", WORLD_TOKEN],
        message: "Unknown option",
      },
    ];
    for (const item of cases) {
      const listen = run(item.argv ?? args(hue.origin, bot.url), item.env);
      expect(await listen.exit).toBe(2);
      expect(listen.stderr()).toContain(item.message);
      expect(listen.stderr()).toContain("Usage: hue listen");
      expect(listen.requests).toEqual([]);
      for (const secret of [PROJECT_KEY, CONNECTION_KEY, WORLD_TOKEN])
        expect(listen.output()).not.toContain(secret);
    }
    expect(hue.pulls).toHaveLength(0);
    expect(bot.requests).toHaveLength(0);
  });

  test("prints its usage", async () => {
    const listen = run(["listen", "--help"], {});
    expect(await listen.exit).toBe(0);
    expect(listen.stdout()).toBe(`${LISTEN_USAGE}\n`);
  });
});

describe("hue listen forwarding", () => {
  test("forwards the handshake and an event unchanged and acknowledges each with the local answer", async () => {
    const hue = await mockHue();
    const verifications: boolean[] = [];
    const bot = await receiver((request, response) => {
      // As Bolt does: the signature over the raw body bytes and the timestamp header.
      const timestamp = String(request.headers["x-slack-request-timestamp"]);
      const expected = sign(request.body.toString("utf8"), timestamp);
      verifications.push(request.headers["x-slack-signature"] === expected);
      const parsed = JSON.parse(request.body.toString("utf8")) as {
        type: string;
        challenge: string;
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        parsed.type === "url_verification" ? JSON.stringify({ challenge: parsed.challenge }) : "",
      );
    });
    const handshake = slackDelivery("url_verification");
    const event = slackDelivery("event_callback", { retryNum: 1 });
    hue.queue.push(handshake, event);
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => hue.acks.length === 2);
    listen.stop();
    expect(await listen.exit).toBe(0);

    expect(bot.requests).toHaveLength(2);
    expect(verifications).toEqual([true, true]);
    for (const delivery of [handshake, event]) {
      const received = bot.requests.find(
        (request) => request.body.toString("utf8") === delivery.body,
      )!;
      expect(received.method).toBe("POST");
      expect(received.url).toBe("/slack/events");
      expect(createHash("sha256").update(received.body).digest("hex")).toBe(
        createHash("sha256").update(Buffer.from(delivery.body, "utf8")).digest("hex"),
      );
      for (const [name, value] of Object.entries(delivery.headers))
        expect(received.headers[name]).toBe(value);
      expect(received.headers["content-length"]).toBe(String(Buffer.byteLength(delivery.body)));
      // Nothing of Hue's own credential reaches the bot.
      expect(received.headers.authorization).toBeUndefined();
      expect(JSON.stringify(received.headers)).not.toContain(WORLD_TOKEN);
    }
    expect(bot.requests.find((r) => r.headers["x-slack-retry-num"] === "1")).toBeDefined();

    const handshakeAck = hue.acks.find((ack) => ack.deliveryId === handshake.deliveryId)!;
    expect(handshakeAck.status).toBe(200);
    expect(handshakeAck.body).toMatchObject({ outcome: "response", status: 200 });
    expect(handshakeAck.body.body).toBe(JSON.stringify({ challenge: "challenge-3eZbrw1aBm" }));
    const eventAck = hue.acks.find((ack) => ack.deliveryId === event.deliveryId)!;
    expect(eventAck.body).toMatchObject({ outcome: "response", status: 200 });
    // An event's answer body stays on this machine; only the handshake's challenge is needed.
    expect(eventAck.body.body).toBeUndefined();
    expect(eventAck.body.noRetry).toBeUndefined();
    for (const ack of hue.acks) {
      expect(ack.body.durationMs as number).toBeLessThanOrEqual(3000);
      // Nothing is acknowledged before the bot answered.
      expect(ack.at).toBeGreaterThanOrEqual(Math.min(...bot.answered));
    }
    expect(hue.refusals).toEqual([]);
    expect(hue.pulls[0]!.waitMs).toBe(0);
    expect(hue.pulls[0]!.max).toBe(10);
    expect(hue.pulls.slice(1).every((pull) => pull.waitMs === 20_000)).toBe(true);

    const output = listen.output();
    expect(output).toContain(`from ${hue.origin} to ${bot.url} using the world token.`);
    expect(output).toContain("Ready: waiting for events.");
    expect(output).toContain("url_verification -> 200");
    expect(output).toContain(`${event.eventId} retry 1 -> 200`);
    expect(output).toContain("Hue: acknowledged");
    expect(output).toContain("Stopped.");
    for (const secret of [
      WORLD_TOKEN,
      BODY_CANARY,
      SIGNING_SECRET,
      VERIFICATION_TOKEN,
      "challenge-3eZbrw1aBm",
    ])
      expect(output).not.toContain(secret);
    expect(output).not.toContain(event.headers["x-slack-signature"]!);
  });

  test("pulls with a connection key for a key's subscription", async () => {
    const hue = await mockHue({ credential: CONNECTION_KEY });
    const bot = await receiver();
    hue.queue.push(slackDelivery("event_callback"));
    const listen = run(args(hue.origin, bot.url), {
      HUE_CONNECTION_KEY: CONNECTION_KEY,
      HUE_API_KEY: PROJECT_KEY,
    });
    await until(() => hue.acks.length === 1);
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(hue.acks[0]!.body).toMatchObject({ outcome: "response", status: 200 });
    expect(listen.output()).not.toContain(CONNECTION_KEY);
  });

  test("reports a redirect without following it, a failure, no-retry and a timeout as the bot answered", async () => {
    const hue = await mockHue();
    const elsewhere = await receiver();
    const texts = ["redirect", "failure", "no-retry", "slow"];
    const bot = await receiver(async (request, response) => {
      const text = (JSON.parse(request.body.toString("utf8")) as { event: { text: string } }).event
        .text;
      if (text === "redirect") {
        response.writeHead(302, { location: elsewhere.url });
        response.end();
      } else if (text === "failure") {
        response.writeHead(500);
        response.end("stack trace with a secret");
      } else if (text === "no-retry") {
        response.writeHead(503, { "x-slack-no-retry": "1" });
        response.end();
      } else {
        await new Promise((tick) => setTimeout(tick, 600));
        response.writeHead(200);
        response.end();
      }
    });
    const deliveries = texts.map((text) => slackDelivery("event_callback", { text }));
    hue.queue.push(...deliveries);
    const listen = run(
      args(hue.origin, bot.url),
      { HUE_WORLD_TOKEN: WORLD_TOKEN },
      {
        forwardTimeoutMs: 250,
      },
    );
    await until(() => hue.acks.length === 4);
    listen.stop();
    expect(await listen.exit).toBe(0);
    const ackFor = (index: number) =>
      hue.acks.find((ack) => ack.deliveryId === deliveries[index]!.deliveryId)!.body;
    expect(ackFor(0)).toMatchObject({ outcome: "response", status: 302 });
    expect(elsewhere.requests).toHaveLength(0);
    expect(ackFor(1)).toMatchObject({ outcome: "response", status: 500 });
    expect(ackFor(1).body).toBeUndefined();
    expect(ackFor(2)).toMatchObject({ outcome: "response", status: 503, noRetry: true });
    expect(ackFor(3)).toMatchObject({ outcome: "timeout" });
    expect(ackFor(3).status).toBeUndefined();
    expect(ackFor(3).durationMs as number).toBeGreaterThanOrEqual(240);
    expect(listen.output()).not.toContain("stack trace");
    expect(listen.output()).toContain("Hue: pending");
  });

  test("reports a receiver that is not running as a failed connection", async () => {
    const hue = await mockHue();
    const closed = createServer();
    const port = await listenOn(closed);
    await new Promise((done) => closed.close(done));
    servers.splice(servers.indexOf(closed), 1);
    hue.queue.push(slackDelivery("event_callback"));
    const listen = run(args(hue.origin, `http://127.0.0.1:${port}/events`), {
      HUE_WORLD_TOKEN: WORLD_TOKEN,
    });
    await until(() => hue.acks.length === 1);
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(hue.acks[0]!.body).toMatchObject({ outcome: "connection_failed" });
    expect(listen.output()).toContain("connection failed");
  });

  test("forwards one pull's deliveries concurrently, never more than --max", async () => {
    for (const max of [3, 2]) {
      const hue = await mockHue();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((open) => (release = open));
      const bot = await receiver(async (_request, response) => {
        await gate;
        response.writeHead(200);
        response.end();
      });
      hue.queue.push(...[1, 2, 3].map(() => slackDelivery("event_callback")));
      const listen = run(args(hue.origin, bot.url, "--max", String(max)), {
        HUE_WORLD_TOKEN: WORLD_TOKEN,
      });
      await until(() => bot.requests.length === max);
      await new Promise((tick) => setTimeout(tick, 100));
      expect(bot.requests).toHaveLength(max);
      release();
      await until(() => hue.acks.length === 3);
      listen.stop();
      expect(await listen.exit).toBe(0);
      expect(bot.peak()).toBe(max);
      expect(hue.pulls.every((pull) => pull.max === max)).toBe(true);
    }
  });

  test("repeats the recorded answer for a delivery handed out again instead of sending it twice", async () => {
    const hue = await mockHue({ repeatDeliveries: true });
    const bot = await receiver();
    const event = slackDelivery("event_callback");
    hue.queue.push(event);
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => hue.acks.length === 2);
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(bot.requests).toHaveLength(1);
    expect(hue.acks.map((ack) => ack.deliveryId)).toEqual([event.deliveryId, event.deliveryId]);
    expect(hue.acks[1]!.body).toEqual(hue.acks[0]!.body);
    expect(hue.acks.map((ack) => ack.status)).toEqual([200, 200]);
    expect(listen.output()).toContain("(repeated)");
  });

  test("a redelivered event (a provider retry) is forwarded again with its retry headers", async () => {
    const hue = await mockHue();
    const bot = await receiver();
    const first = slackDelivery("event_callback");
    const retry = { ...slackDelivery("event_callback", { retryNum: 2 }), eventId: first.eventId };
    hue.queue.push(first);
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => hue.acks.length === 1);
    hue.queue.push(retry);
    await until(() => hue.acks.length === 2);
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(bot.requests).toHaveLength(2);
    expect(bot.requests[1]!.headers["x-slack-retry-num"]).toBe("2");
    expect(bot.requests[1]!.headers["x-slack-retry-reason"]).toBe("http_timeout");
  });
});

describe("hue listen acknowledgements and refusals", () => {
  test("retries a failed pull and keeps credentials out of the error it prints", async () => {
    const hue = await mockHue();
    const bot = await receiver();
    hue.queue.push(slackDelivery("event_callback"));
    let failed = false;
    const listen = run(
      args(hue.origin, bot.url),
      { HUE_WORLD_TOKEN: WORLD_TOKEN },
      {
        fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (!failed) {
            failed = true;
            return Promise.reject(
              new Error(
                `connect ECONNRESET with Authorization: Bearer ${WORLD_TOKEN} (${WORLD_TOKEN})`,
              ),
            );
          }
          return fetch(input, init);
        }) as typeof fetch,
      },
    );
    await until(() => hue.acks.length === 1);
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(listen.stderr()).toContain("Pull failed: connect ECONNRESET");
    expect(listen.stderr()).toContain("[redacted]");
    expect(listen.output()).not.toContain(WORLD_TOKEN);
    expect(listen.output()).not.toContain(WORLD_TOKEN.slice(0, 30));
  });

  test("repeats an acknowledgement Hue did not answer, and stops at an expired lease", async () => {
    const hue = await mockHue({ ackFailures: 2 });
    const bot = await receiver();
    hue.queue.push(slackDelivery("event_callback"));
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => hue.acks.some((ack) => ack.status === 200));
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(hue.acks.map((ack) => ack.status)).toEqual([503, 503, 200]);
    // Retry-After: 0 is not taken literally: the backoff (250 ms, then 500 ms) still applies.
    expect(hue.acks[1]!.at - hue.acks[0]!.at).toBeGreaterThanOrEqual(200);
    expect(hue.acks[2]!.at - hue.acks[1]!.at).toBeGreaterThanOrEqual(450);
    expect(new Set(hue.acks.map((ack) => JSON.stringify(ack.body))).size).toBe(1);
    expect(bot.requests).toHaveLength(1);

    const expired = await mockHue({ leaseMs: 0 });
    expired.queue.push(slackDelivery("event_callback"));
    const late = run(args(expired.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => expired.acks.length === 1);
    await new Promise((tick) => setTimeout(tick, 200));
    late.stop();
    expect(await late.exit).toBe(0);
    expect(expired.acks.map((ack) => ack.status)).toEqual([409]);
    expect(late.output()).toContain("lease expired");
  });

  test("stops with the reason when Hue refuses the credential or the subscription", async () => {
    const bot = await receiver();
    const cases: Array<{ options: MockOptions; env: Record<string, string>; message: string }> = [
      {
        options: { credential: WORLD_TOKEN },
        env: { HUE_CONNECTION_KEY: PROJECT_KEY },
        message: `Hue refused the connection key (HTTP 401 credential_not_subscription): it is not subscription ${SUBSCRIPTION}'s credential, or it ended (a world token ends when its world seals). A project key never pulls.`,
      },
      {
        options: { credential: CONNECTION_KEY },
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        message: "A project key never pulls",
      },
      {
        options: { mode: "http" },
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        message: "needs a listen subscription",
      },
      {
        options: { revoked: true },
        env: { HUE_WORLD_TOKEN: WORLD_TOKEN },
        message: `Subscription ${SUBSCRIPTION} is revoked`,
      },
    ];
    for (const item of cases) {
      const hue = await mockHue(item.options);
      const listen = run(args(hue.origin, bot.url), item.env);
      expect(await listen.exit).toBe(1);
      expect(listen.stderr()).toContain(item.message);
      expect(hue.pulls).toHaveLength(0);
      for (const secret of [PROJECT_KEY, CONNECTION_KEY, WORLD_TOKEN])
        expect(listen.output()).not.toContain(secret);
    }
    const hue = await mockHue();
    const other = run(
      ["listen", "--subscription", randomUUID(), "--forward-to", bot.url, "--origin", hue.origin],
      { HUE_WORLD_TOKEN: WORLD_TOKEN },
    );
    expect(await other.exit).toBe(1);
    expect(other.stderr()).toContain("Hue has no subscription");
    expect(bot.requests).toHaveLength(0);
  });

  test("waits out another open pull, then delivers", async () => {
    const hue = await mockHue({ busyPulls: 2 });
    const bot = await receiver();
    hue.queue.push(slackDelivery("event_callback"));
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => hue.acks.length === 1);
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(hue.refusals.filter((refusal) => refusal.status === 409)).toHaveLength(2);
    expect(listen.stderr()).toContain("another pull is open for this subscription");
  });
});

describe("hue listen delivery safety", () => {
  test("parses only deliveries it can forward unchanged", () => {
    const queued = slackDelivery("event_callback");
    const base = wire(queued);
    expect(parseDelivery(base, SUBSCRIPTION)).toMatchObject({
      deliveryId: queued.deliveryId,
      kind: "event_callback",
      request: { headers: queued.headers, body: queued.body },
    });
    const headers = (value: Record<string, string>) => ({
      ...base,
      request: { ...base.request, headers: value },
    });
    const refused: unknown[] = [
      { ...base, subscriptionId: randomUUID() },
      { ...base, deliveryId: "../../5b0f6a52-3c1e-4d7a-9e55-0c2b8f1d9a11" },
      { ...base, kind: "block_actions" },
      { ...base, retryNum: -1 },
      { ...base, eventId: "Ev\u001b[31m" },
      { ...base, request: { ...base.request, method: "GET" } },
      { ...base, request: { ...base.request, body: 42 } },
      headers({ ...queued.headers, "x-injected": "a\r\nset-cookie: b" }),
      headers({ ...queued.headers, "bad name": "x" }),
      headers({ "Content-Type": "application/json", "content-type": "text/plain" }),
    ];
    for (const value of refused) expect(parseDelivery(value, SUBSCRIPTION)).toBeNull();
    // Header names keep the spelling Hue sent; HTTP compares them case-insensitively.
    const mixed = parseDelivery(
      headers({ "Content-Type": "application/json", "X-Slack-Signature": "v0=1" }),
      SUBSCRIPTION,
    )!;
    expect(mixed.request.headers).toEqual({
      "Content-Type": "application/json",
      "X-Slack-Signature": "v0=1",
    });
  });

  test("admits a --forward-to name only when every address it resolves to is loopback", async () => {
    const bot = await receiver();
    const queued = slackDelivery("event_callback");
    // Any header spelling is forwarded, and a stale Content-Length never reaches the bot.
    const delivery = parseDelivery(
      wire({
        ...queued,
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Signature": queued.headers["x-slack-signature"]!,
          "Content-Length": "1",
          Host: "attacker.example",
          Connection: "upgrade",
        },
      }),
      SUBSCRIPTION,
    )!;
    const target = new URL(`http://bot.localhost:${bot.port}/events`);
    const resolving = (addresses: Array<{ address: string; family: number }>) =>
      ((_host: string, _options: unknown, callback: (error: null, found: unknown) => void) =>
        callback(null, addresses)) as unknown as typeof lookup;
    for (const addresses of [
      [{ address: "10.0.0.5", family: 4 }],
      [
        { address: "127.0.0.1", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
      [],
    ])
      expect(
        await forwardDelivery(target, delivery, { resolver: resolving(addresses) }),
      ).toMatchObject({ outcome: "connection_failed" });
    expect(bot.requests).toHaveLength(0);
    expect(
      await forwardDelivery(target, delivery, {
        resolver: resolving([{ address: "127.0.0.1", family: 4 }]),
      }),
    ).toMatchObject({ outcome: "response", status: 200 });
    expect(bot.requests).toHaveLength(1);
    expect(bot.requests[0]!.body.toString("utf8")).toBe(queued.body);
    expect(bot.requests[0]!.headers["content-length"]).toBe(String(Buffer.byteLength(queued.body)));
    expect(bot.requests[0]!.headers["x-slack-signature"]).toBe(queued.headers["x-slack-signature"]);
    expect(bot.requests[0]!.headers.host).toBe(`bot.localhost:${bot.port}`);
    expect(bot.requests[0]!.headers.connection).not.toBe("upgrade");
    // With --allow-remote-forward the name is resolved as usual.
    expect(
      await forwardDelivery(new URL(`http://localhost:${bot.port}/events`), delivery, {
        allowRemote: true,
      }),
    ).toMatchObject({ outcome: "response", status: 200 });
  });

  test("reports a failed TLS handshake as a TLS error", async () => {
    const plain = await receiver();
    const delivery = parseDelivery(wire(slackDelivery("event_callback")), SUBSCRIPTION)!;
    expect(
      await forwardDelivery(new URL(`https://127.0.0.1:${plain.port}/events`), delivery),
    ).toMatchObject({ outcome: "tls_error" });
  });

  test("sends a URL verification's answer body only when it succeeds, cut to 4 KiB", async () => {
    let reply: (response: ServerResponse) => void = () => undefined;
    const bot = await receiver((_request, response) => reply(response));
    const target = new URL(`http://127.0.0.1:${bot.port}/slack/events`);
    const handshake = parseDelivery(wire(slackDelivery("url_verification")), SUBSCRIPTION)!;
    reply = (response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("✓".repeat(3000));
    };
    const long = await forwardDelivery(target, handshake);
    expect(long).toMatchObject({ outcome: "response", status: 200 });
    expect(Buffer.byteLength(long!.body!)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(long!.body!)).toBeGreaterThan(4090);
    expect(long!.body!.replaceAll("✓", "")).toBe("");
    reply = (response) => {
      response.writeHead(500);
      response.end("stack trace with a secret");
    };
    const failed = await forwardDelivery(target, handshake);
    expect(failed).toMatchObject({ outcome: "response", status: 500 });
    expect(failed!.body).toBeUndefined();
  });

  test("loads the credential from --env-path", async () => {
    const hue = await mockHue();
    const bot = await receiver();
    const directory = await mkdtemp(join(tmpdir(), "hue-listen-env-"));
    try {
      await writeFile(join(directory, ".env.world"), `HUE_WORLD_TOKEN=${WORLD_TOKEN}\n`);
      hue.queue.push(slackDelivery("event_callback"));
      const listen = run(
        [...args(hue.origin, bot.url), "--env-path", ".env.world"],
        {},
        {
          cwd: directory,
        },
      );
      await until(() => hue.acks.length === 1);
      listen.stop();
      expect(await listen.exit).toBe(0);
      expect(listen.output()).not.toContain(WORLD_TOKEN);
      const missing = run(
        [...args(hue.origin, bot.url), "--env-path", "missing.env"],
        {},
        {
          cwd: directory,
        },
      );
      expect(await missing.exit).toBe(2);
      expect(missing.stderr()).toContain("Unable to load missing.env");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("never retries a pull faster than its backoff, whatever Retry-After says", async () => {
    const hue = await mockHue({ pullFailures: 3 });
    const bot = await receiver();
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => hue.pulls.length >= 1);
    listen.stop();
    expect(await listen.exit).toBe(0);
    const [first, second, third, fourth] = hue.pullAttempts;
    expect(second! - first!).toBeGreaterThanOrEqual(15);
    expect(third! - second!).toBeGreaterThanOrEqual(35);
    expect(fourth! - third!).toBeGreaterThanOrEqual(70);
    expect(listen.stderr()).toContain("Pull failed: HTTP 503 unavailable");
  });

  test("forwards no more than --max even when Hue leases more", async () => {
    const hue = await mockHue({ overfill: true });
    const bot = await receiver();
    hue.queue.push(...[1, 2, 3, 4, 5].map(() => slackDelivery("event_callback")));
    const listen = run(args(hue.origin, bot.url, "--max", "2"), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => hue.acks.length === 2);
    await new Promise((tick) => setTimeout(tick, 100));
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(bot.requests).toHaveLength(2);
    expect(bot.peak()).toBeLessThanOrEqual(2);
    expect(listen.stderr()).toContain("Hue leased 3 more delivery(ies) than --max 2");
  });

  test("stops repeating an acknowledgement when the lease Hue stated has ended", async () => {
    // The lease ends 2.5 s after the answer's Date, so repeats stop well inside 30 s.
    const hue = await mockHue({ leaseMs: 2_500, ackFailures: 1_000 });
    const bot = await receiver();
    hue.queue.push(slackDelivery("event_callback"));
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => listen.stdout().includes("did not answer the acknowledgement"), 4_000);
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(hue.acks.length).toBeGreaterThanOrEqual(1);
    expect(hue.acks.length).toBeLessThanOrEqual(5);
    expect(hue.acks.every((ack) => ack.status === 503)).toBe(true);
  });
});

describe("hue listen shutdown", () => {
  test("a stop during a forward finishes it and its acknowledgement, then pulls no more", async () => {
    const hue = await mockHue();
    let answeredAt = 0;
    const bot = await receiver(async (_request, response) => {
      await new Promise((tick) => setTimeout(tick, 400));
      answeredAt = Date.now();
      response.writeHead(200);
      response.end();
    });
    hue.queue.push(slackDelivery("event_callback"));
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => bot.requests.length === 1);
    listen.stop();
    const pullsAtStop = hue.pulls.length;
    expect(await listen.exit).toBe(0);
    expect(hue.acks).toHaveLength(1);
    expect(hue.acks[0]!.body).toMatchObject({ outcome: "response", status: 200 });
    expect(hue.acks[0]!.at).toBeGreaterThanOrEqual(answeredAt);
    expect(hue.pulls).toHaveLength(pullsAtStop);
    expect(listen.stderr()).toContain("Stopping");
  });

  test("a stop during a waiting pull ends it at once without acknowledging anything", async () => {
    const hue = await mockHue();
    const bot = await receiver();
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => hue.pulls.length === 2 && hue.isPullOpen());
    const stoppedAt = Date.now();
    listen.stop();
    expect(await listen.exit).toBe(0);
    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
    await until(() => hue.pulls[1]!.closedEarly);
    expect(hue.acks).toHaveLength(0);
  });

  test("a second stop abandons acknowledgements, so nothing unanswered is acknowledged", async () => {
    const hue = await mockHue();
    const bot = await receiver(async (_request, response) => {
      await new Promise((tick) => setTimeout(tick, 2_000));
      response.writeHead(200);
      response.end();
    });
    hue.queue.push(slackDelivery("event_callback"));
    const listen = run(args(hue.origin, bot.url), { HUE_WORLD_TOKEN: WORLD_TOKEN });
    await until(() => bot.requests.length === 1);
    listen.stop();
    listen.stop();
    expect(await listen.exit).toBe(130);
    await new Promise((tick) => setTimeout(tick, 100));
    expect(hue.acks).toHaveLength(0);
    expect(listen.stdout()).toContain("-> abandoned; not acknowledged");
    expect(listen.output()).not.toContain("connection failed");
  });

  test("the hue binary stops on SIGINT after acknowledging the delivery in flight", async () => {
    const hue = await mockHue();
    const bot = await receiver(async (_request, response) => {
      await new Promise((tick) => setTimeout(tick, 500));
      response.writeHead(200);
      response.end();
    });
    hue.queue.push(slackDelivery("event_callback"));
    const child = spawn(process.execPath, [cli, ...args(hue.origin, bot.url)], {
      env: { PATH: process.env.PATH ?? "", HUE_WORLD_TOKEN: WORLD_TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
    await until(() => bot.requests.length === 1, 30_000);
    child.kill("SIGINT");
    expect(await closed).toBe(0);
    expect(hue.acks).toHaveLength(1);
    expect(hue.acks[0]!.body).toMatchObject({ outcome: "response", status: 200 });
    expect(output).toContain("Stopped.");
    expect(output).not.toContain(WORLD_TOKEN);
    expect(output).not.toContain(BODY_CANARY);
  }, 40_000);
});
