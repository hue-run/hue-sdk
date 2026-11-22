import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createEnvironmentClient } from "../src/environment.js";
import { createWorldClient, type WorldClient } from "../src/world.js";

// libpq conninfo_storeval replaces sslmode in place, so the last assignment is the one used.
function libpqSslmode(connectionUrl: string): string | undefined {
  const mark = connectionUrl.indexOf("?");
  if (mark < 0) return undefined;
  let sslmode: string | undefined;
  for (const pair of connectionUrl.slice(mark + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const keyword = libpqDecode(pair.slice(0, eq));
    const value = libpqDecode(pair.slice(eq + 1));
    if (keyword === "ssl" && value === "true") sslmode = "require";
    else if (keyword === "requiressl") sslmode = value.startsWith("1") ? "require" : "prefer";
    else if (keyword === "sslmode") sslmode = value;
  }
  return sslmode;
}

function libpqDecode(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== "%") {
      out += char;
      continue;
    }
    const hex = text.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error("bad percent-encoding");
    const code = Number.parseInt(hex, 16);
    if (code === 0) throw new Error("forbidden percent-encoding");
    out += String.fromCharCode(code);
    i += 2;
  }
  return out;
}

const clients = [createWorldClient, createEnvironmentClient] as const;

const safeUrl = "postgresql://user:synthetic@127.0.0.1/db?sslmode=verify-full";

const attackedUrls = [
  "postgresql://user:synthetic@127.0.0.1/db?sslmode=verify-full&sslmode=disable",
  "postgres://user:synthetic@10.0.0.8/db?sslmode=verify-full&sslmode=disable",
  "postgresql://user:synthetic@127.0.0.1/db?sslmode=verify-full&sslmode=disa%62le",
  "postgresql://user:synthetic@127.0.0.1/db?sslmode=verify-full&ssl=true",
  "postgresql://user:synthetic@127.0.0.1/db?sslmode=verify-full&requiressl=0",
];

async function withOffered(
  offered: string,
  create: (typeof clients)[number],
  use: (client: WorldClient) => Promise<void>,
) {
  const instanceId = randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      await request.json().catch(() => undefined);
      if (path.endsWith("/native-connection")) {
        return Response.json({ state: "ready", url: offered });
      }
      if (path.endsWith("/finish")) return Response.json({});
      return Response.json({
        id: instanceId,
        nativeApps: [{ appKey: "postgres", providerId: "postgres", state: "ready" }],
      });
    },
  });
  try {
    await use(create({ apiKey: "synthetic-world-key", baseUrl: server.url.origin }));
  } finally {
    server.stop(true);
  }
}

test("a single sslmode=verify-full URL is handed to the callback", async () => {
  for (const create of clients) {
    await withOffered(safeUrl, create, async (client) => {
      let handed: string | undefined;
      await client.withPostgres(
        { idempotencyKey: randomUUID(), worldVersionId: randomUUID() },
        async (url) => {
          handed = url;
        },
      );
      if (handed === undefined) throw new Error("missing URL");
      expect(libpqSslmode(handed)).toBe("verify-full");
    });
  }
});

test.each(attackedUrls)("driver-effective sslmode stays verify-full for %s", async (offered) => {
  for (const create of clients) {
    await withOffered(offered, create, async (client) => {
      let handed: string | undefined;
      const settled = await Promise.allSettled([
        client.withPostgres(
          { idempotencyKey: randomUUID(), worldVersionId: randomUUID() },
          async (url) => {
            handed = url;
          },
        ),
      ]);
      if (handed === undefined) {
        expect(settled[0]?.status).toBe("rejected");
        return;
      }
      expect(handed).not.toBe(offered);
      expect(libpqSslmode(handed)).toBe("verify-full");
    });
  }
});
