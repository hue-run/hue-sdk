#!/usr/bin/env node
// Synthetic loopback checks against an exact installed private transport module.
import { createHmac, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";

let checks = 0;
let reported = false;
function report(passed, afterWrite = () => undefined) {
  if (reported) {
    afterWrite();
    return;
  }
  reported = true;
  process.stdout.write(
    JSON.stringify({ passed, checks, runtime: process.versions.bun ? "bun" : "node" }) + "\n",
    afterWrite,
  );
}
function check(value) {
  if (!value) throw new Error("Installed socket check failed");
}
async function refuses(operation) {
  let refused = false;
  try {
    await operation();
  } catch {
    refused = true;
  }
  check(refused);
}
function proof(nonce, serverPort, clientPort) {
  const digest = createHmac("sha256", Buffer.from(nonce, "base64url"))
    .update(`hue-setup-owned-v1\0${serverPort}\0${clientPort}`)
    .digest("base64url");
  return Buffer.from(`Hue-setup-owned:${digest}\n`, "ascii");
}
async function listener(handler, port = 0) {
  const sockets = new Set();
  const stats = { connections: 0, bytes: 0, requests: 0 };
  const server = createServer((socket) => {
    stats.connections++;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let head = "",
      complete = false;
    socket.on("data", (chunk) => {
      stats.bytes += chunk.length;
      if (!complete) {
        head += chunk.toString("ascii");
        if (head.includes("\r\n\r\n")) {
          complete = true;
          if (head.startsWith("GET /owned HTTP/1.1\r\n")) stats.requests++;
        }
      }
    });
    handler(socket, stats);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    stats,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const watchdog = setTimeout(() => {
  report(false, () => process.exit(1));
}, 10000);
try {
  const args = process.argv.slice(2);
  check(args.length === 2 && args[0] === "--module" && isAbsolute(args[1]));
  check((await lstat(args[1])).isFile());
  const { setupSocketPreface, connectOwnedApplication, requestOwnedApplication } = await import(
    pathToFileURL(args[1]).href
  );
  check(
    [setupSocketPreface, connectOwnedApplication, requestOwnedApplication].every(
      (value) => typeof value === "function",
    ),
  );
  const nonce = randomBytes(32).toString("base64url");
  const frame = setupSocketPreface(nonce, 30001, 40002);
  check(frame.equals(proof(nonce, 30001, 40002)) && !frame.includes(nonce));
  check(!frame.equals(proof(nonce, 30001, 40003)) && !frame.equals(proof(nonce, 30002, 40002)));
  checks++;

  for (const mode of [
    "whole",
    "split",
    "partial-body",
    "header-budget",
    "body-budget",
    "redirect",
    "timeout",
  ]) {
    const peer = await listener((socket, stats) => {
      const prefix = proof(nonce, socket.localPort, socket.remotePort);
      socket.write(mode === "split" ? prefix.subarray(0, 9) : prefix);
      if (mode === "split") setTimeout(() => socket.write(prefix.subarray(9)), 5);
      let sent = false;
      socket.on("data", () => {
        if (sent || stats.requests === 0) return;
        sent = true;
        if (mode === "partial-body" || mode === "timeout") {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx");
          if (mode === "partial-body") socket.end();
        } else if (mode === "header-budget") {
          socket.end(
            `HTTP/1.1 200 OK\r\nX-Overflow: ${"a".repeat(20000)}\r\nContent-Length: 0\r\n\r\n`,
          );
        } else if (mode === "body-budget") {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n");
          socket.end(Buffer.alloc(1048577, 65));
        } else if (mode === "redirect") {
          socket.end(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/foreign\r\nContent-Length: 0\r\n\r\n",
          );
        } else {
          socket.write(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\na\r\n",
          );
          setTimeout(() => socket.end("1\r\nb\r\n0\r\nX-Complete: yes\r\n\r\n"), 5);
        }
      });
    });
    try {
      const socket = await connectOwnedApplication(peer.port, nonce, () => true, 500);
      check(peer.stats.bytes === 0 && peer.stats.requests === 0);
      const send = () =>
        requestOwnedApplication(socket, new URL(`http://127.0.0.1:${peer.port}/owned`), 200);
      if (mode === "whole" || mode === "split") check((await send()) === undefined);
      else await refuses(send);
      check(peer.stats.connections === 1 && peer.stats.requests === 1);
      checks++;
    } finally {
      await peer.close();
    }
  }

  for (const mode of [
    "wrong-key",
    "wrong-port",
    "oversized",
    "extra",
    "truncated",
    "eof",
    "silent",
  ]) {
    const peer = await listener((socket) => {
      const prefix = proof(nonce, socket.localPort, socket.remotePort);
      if (mode === "wrong-key")
        socket.write(
          proof(randomBytes(32).toString("base64url"), socket.localPort, socket.remotePort),
        );
      else if (mode === "wrong-port")
        socket.write(
          proof(
            nonce,
            socket.localPort,
            socket.remotePort === 65535 ? 65534 : socket.remotePort + 1,
          ),
        );
      else if (mode === "oversized") socket.write(Buffer.alloc(4096, 65));
      else if (mode === "extra")
        socket.write(Buffer.concat([prefix, Buffer.from("HTTP/1.1 200 OK\r\n\r\n")]));
      else if (mode === "truncated") socket.end(prefix.subarray(0, prefix.length - 1));
      else if (mode === "eof") socket.end();
    });
    try {
      await refuses(() => connectOwnedApplication(peer.port, nonce, () => true, 150));
      await wait(5);
      check(peer.stats.connections === 1 && peer.stats.bytes === 0 && peer.stats.requests === 0);
      checks++;
    } finally {
      await peer.close();
    }
  }

  const original = await listener((socket) =>
    socket.write(proof(nonce, socket.localPort, socket.remotePort)),
  );
  const socket = await connectOwnedApplication(original.port, nonce, () => true, 500);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await original.close();
  await closed;
  check(original.stats.bytes === 0 && original.stats.requests === 0);
  const replacement = await listener((peer) => peer.destroy(), original.port);
  try {
    await refuses(() =>
      requestOwnedApplication(socket, new URL(`http://127.0.0.1:${original.port}/owned`), 200),
    );
    await wait(10);
    check(replacement.stats.connections === 0 && replacement.stats.bytes === 0);
    checks++;
  } finally {
    await replacement.close();
  }
  report(true);
} catch {
  // Never propagate transport errors, imported exception text, proof bytes or paths.
  report(false, () => process.exit(1));
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
}
