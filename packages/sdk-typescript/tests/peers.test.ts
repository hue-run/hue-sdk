import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { loadCommand, MissingPeerError } from "../src/setup/peers.js";

const failing = (message: string) => () => Promise.reject(new Error(message));

test("a command whose peer is not installed names it and how to install it", async () => {
  // Node's resolution error for a bare peer, and Bun's for a scoped one.
  const zod = await loadCommand(
    "eval",
    failing("Cannot find package 'zod' imported from /app/node_modules/@hue-run/sdk/dist/x.js"),
  ).catch((error: unknown) => error);
  expect(zod).toBeInstanceOf(MissingPeerError);
  expect(zod).toMatchObject({ command: "eval", peer: "zod", range: pkg.peerDependencies.zod });
  expect((zod as Error).message).toBe(
    `hue eval needs zod, a peer dependency of @hue-run/sdk that this project has not installed. Install it with: npm install "zod@${pkg.peerDependencies.zod}" (or bun add, pnpm add or yarn add with the same argument)`,
  );
  const api = await loadCommand(
    "mcp",
    failing('Cannot find module "@opentelemetry/api/build/src/index.js" from "/app/cli.js"'),
  ).catch((error: unknown) => error);
  expect(api).toMatchObject({
    peer: "@opentelemetry/api",
    range: pkg.peerDependencies["@opentelemetry/api"],
  });
});

test("any other failure, and a missing package that is not a peer, is left as it was", async () => {
  const notPeer = new Error("Cannot find package 'left-pad' imported from /app/agent.mjs");
  await expect(loadCommand("eval", () => Promise.reject(notPeer))).rejects.toBe(notPeer);
  const other = new TypeError("boom");
  await expect(loadCommand("eval", () => Promise.reject(other))).rejects.toBe(other);
  expect(await loadCommand("eval", async () => ({ ok: true }))).toEqual({ ok: true });
});
