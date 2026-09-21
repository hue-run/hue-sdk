import { expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import {
  connectOwnedApplication,
  requestOwnedApplication,
  setupSocketPreface,
} from "../src/setup/socket.js";

function proof(nonce: string, serverPort: number, clientPort: number): Buffer {
  const mac = createHmac("sha256", Buffer.from(nonce, "base64url"))
    .update(`hue-setup-owned-v1\0${serverPort}\0${clientPort}`)
    .digest("base64url");
  return Buffer.from(`Hue-setup-owned:${mac}\n`, "ascii");
}

async function listener(onConnection: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No owned test listener");
  return {
    server,
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function onRequest(socket: Socket, callback: () => void) {
  let received = "";
  let completed = false;
  socket.on("data", (data: Buffer) => {
    if (completed) return;
    received += data.toString("ascii");
    if (received.includes("\r\n\r\n")) {
      completed = true;
      if (!received.startsWith("GET /owned HTTP/1.1\r\n")) socket.destroy();
      else callback();
    }
  });
}

test("ownership preface uses the frozen HMAC domain and exact socket ports, not a raw nonce", () => {
  const nonce = randomBytes(32).toString("base64url");
  const actual = setupSocketPreface(nonce, 30001, 40002);
  expect(actual.equals(proof(nonce, 30001, 40002))).toBe(true);
  expect(actual.includes(nonce)).toBe(false);
  expect(actual.equals(proof(nonce, 30001, 40003))).toBe(false);
  expect(actual.equals(proof(nonce, 30002, 40002))).toBe(false);
});

for (const split of [false, true]) {
  test(`authenticates ${split ? "fragmented" : "whole"} proof before one request and drains a chunked response`, async () => {
    const nonce = randomBytes(32).toString("base64url");
    let connections = 0;
    let requests = 0;
    const peer = await listener((socket) => {
      connections += 1;
      const frame = proof(nonce, socket.localPort!, socket.remotePort!);
      if (split) {
        socket.write(frame.subarray(0, 7));
        setTimeout(() => socket.write(frame.subarray(7)), 5);
      } else socket.write(frame);
      onRequest(socket, () => {
        requests += 1;
        socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
        socket.write("1\r\na\r\n");
        setTimeout(() => socket.end("1\r\nb\r\n0\r\nX-Complete: yes\r\n\r\n"), 5);
      });
    });
    try {
      const socket = await connectOwnedApplication(peer.port, nonce, () => true, 500);
      expect(requests).toBe(0);
      await requestOwnedApplication(socket, new URL(`http://127.0.0.1:${peer.port}/owned`), 500);
      expect(requests).toBe(1);
      expect(connections).toBe(1);
    } finally {
      await peer.close();
    }
  });
}

for (const failure of [
  "wrong-key",
  "wrong-port",
  "oversized",
  "extra-response",
  "truncated",
  "eof",
  "silent",
] as const) {
  test(`accepted ${failure} proof fails terminally without sending any HTTP or reconnecting`, async () => {
    const nonce = randomBytes(32).toString("base64url");
    let connections = 0;
    let clientBytes = 0;
    const peer = await listener((socket) => {
      connections += 1;
      socket.on("data", (chunk: Buffer) => (clientBytes += chunk.length));
      const frame = proof(nonce, socket.localPort!, socket.remotePort!);
      switch (failure) {
        case "wrong-key":
          socket.write(
            proof(randomBytes(32).toString("base64url"), socket.localPort!, socket.remotePort!),
          );
          break;
        case "wrong-port":
          socket.write(
            proof(
              nonce,
              socket.localPort!,
              socket.remotePort! === 65535 ? 65534 : socket.remotePort! + 1,
            ),
          );
          break;
        case "oversized":
          socket.write(Buffer.alloc(4096, 65));
          break;
        case "extra-response":
          socket.write(Buffer.concat([frame, Buffer.from("HTTP/1.1 200 OK\r\n\r\n")]));
          break;
        case "truncated":
          socket.end(frame.subarray(0, frame.length - 1));
          break;
        case "eof":
          socket.end();
          break;
        case "silent":
          break;
      }
    });
    try {
      await expect(connectOwnedApplication(peer.port, nonce, () => true, 150)).rejects.toThrow();
      await wait(10);
      expect(connections).toBe(1);
      expect(clientBytes).toBe(0);
    } finally {
      await peer.close();
    }
  });
}

test("connection refusal before readiness may retry but an accepted listener receives one request only", async () => {
  const nonce = randomBytes(32).toString("base64url");
  const reservation = await listener(() => undefined);
  const port = reservation.port;
  await reservation.close();
  let requests = 0;
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.on("error", () => undefined);
    socket.write(proof(nonce, socket.localPort!, socket.remotePort!));
    onRequest(socket, () => {
      requests += 1;
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  const connecting = connectOwnedApplication(port, nonce, () => true, 1000);
  try {
    await wait(75);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const socket = await connecting;
    await requestOwnedApplication(socket, new URL(`http://127.0.0.1:${port}/owned`), 500);
    expect(connections).toBe(1);
    expect(requests).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a closed authenticated socket never dials a port-takeover listener", async () => {
  const nonce = randomBytes(32).toString("base64url");
  let initialBytes = 0;
  const original = await listener((socket) => {
    socket.write(proof(nonce, socket.localPort!, socket.remotePort!));
    socket.on("data", (chunk: Buffer) => (initialBytes += chunk.length));
  });
  const socket = await connectOwnedApplication(original.port, nonce, () => true, 500);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await original.close();
  await closed;
  let replacementConnections = 0;
  let replacementBytes = 0;
  const replacement = createServer((peer) => {
    replacementConnections += 1;
    peer.on("data", (chunk: Buffer) => (replacementBytes += chunk.length));
    peer.on("error", () => undefined);
    peer.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(original.port, "127.0.0.1", resolve);
  });
  try {
    await expect(
      requestOwnedApplication(socket, new URL(`http://127.0.0.1:${original.port}/owned`), 200),
    ).rejects.toThrow();
    await wait(20);
    expect(initialBytes).toBe(0);
    expect(replacementConnections).toBe(0);
    expect(replacementBytes).toBe(0);
  } finally {
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  }
});

for (const failure of [
  "redirect",
  "status",
  "header-budget",
  "body-budget",
  "partial-body",
  "timeout",
] as const) {
  test(`${failure} after the one business request fails without retry`, async () => {
    const nonce = randomBytes(32).toString("base64url");
    let requests = 0;
    let connections = 0;
    const peer = await listener((socket) => {
      connections += 1;
      socket.write(proof(nonce, socket.localPort!, socket.remotePort!));
      onRequest(socket, () => {
        requests += 1;
        switch (failure) {
          case "redirect":
            socket.end(
              "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/unrelated\r\nContent-Length: 0\r\n\r\n",
            );
            break;
          case "status":
            socket.end("HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n");
            break;
          case "header-budget":
            socket.end(
              `HTTP/1.1 200 OK\r\nX-Oversized: ${"a".repeat(20000)}\r\nContent-Length: 0\r\n\r\n`,
            );
            break;
          case "body-budget":
            socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n");
            socket.end(Buffer.alloc(1048577, 65));
            break;
          case "partial-body":
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx");
            break;
          case "timeout":
            socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx");
            break;
        }
      });
    });
    try {
      const socket = await connectOwnedApplication(peer.port, nonce, () => true, 500);
      await expect(
        requestOwnedApplication(socket, new URL(`http://127.0.0.1:${peer.port}/owned`), 150),
      ).rejects.toThrow();
      expect(connections).toBe(1);
      expect(requests).toBe(1);
    } finally {
      await peer.close();
    }
  });
}

test("abort and exited-child boundaries do not send a business request", async () => {
  const nonce = randomBytes(32).toString("base64url");
  let received = 0;
  let connections = 0;
  const peer = await listener((socket) => {
    connections += 1;
    socket.on("data", (chunk: Buffer) => (received += chunk.length));
  });
  try {
    await expect(connectOwnedApplication(peer.port, nonce, () => false, 500)).rejects.toThrow();
    expect(connections).toBe(0);
    const abort = new AbortController();
    const connecting = connectOwnedApplication(peer.port, nonce, () => true, 500, abort.signal);
    setTimeout(() => abort.abort(), 20);
    await expect(connecting).rejects.toThrow();
    expect(connections).toBe(1);
    expect(received).toBe(0);
  } finally {
    await peer.close();
  }
});

test("interruption after ownership proof closes the retained socket without HTTP", async () => {
  const nonce = randomBytes(32).toString("base64url");
  let received = 0;
  let connections = 0;
  const peer = await listener((socket) => {
    connections += 1;
    socket.on("data", (chunk: Buffer) => (received += chunk.length));
    socket.write(proof(nonce, socket.localPort!, socket.remotePort!));
  });
  try {
    const socket = await connectOwnedApplication(peer.port, nonce, () => true, 500);
    const abort = new AbortController();
    abort.abort();
    await expect(
      requestOwnedApplication(
        socket,
        new URL(`http://127.0.0.1:${peer.port}/owned`),
        500,
        abort.signal,
      ),
    ).rejects.toThrow();
    await wait(10);
    expect(connections).toBe(1);
    expect(received).toBe(0);
  } finally {
    await peer.close();
  }
});

test("the exact response byte budget succeeds without retaining body content", async () => {
  const nonce = randomBytes(32).toString("base64url");
  let requests = 0;
  const peer = await listener((socket) => {
    socket.write(proof(nonce, socket.localPort!, socket.remotePort!));
    onRequest(socket, () => {
      requests += 1;
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n");
      socket.end(Buffer.alloc(1048576, 65));
    });
  });
  try {
    const socket = await connectOwnedApplication(peer.port, nonce, () => true, 500);
    const value = await requestOwnedApplication(
      socket,
      new URL(`http://127.0.0.1:${peer.port}/owned`),
      500,
    );
    expect(value).toBeUndefined();
    expect(requests).toBe(1);
  } finally {
    await peer.close();
  }
});

test("actual Node runtime authenticates and uses one socket with no fallback", () => {
  const module = new URL("../src/setup/socket.ts", import.meta.url).href;
  const script = `
    import { createHmac, randomBytes } from "node:crypto";
    import { createServer } from "node:net";
    import { connectOwnedApplication, requestOwnedApplication } from ${JSON.stringify(module)};
    const nonce = randomBytes(32).toString("base64url");
    let calls = 0, connections = 0;
    const server = createServer(socket => {
      connections++;
      socket.on("error", () => undefined);
      const domain = "hue-setup-owned-v1\\0" + socket.localPort + "\\0" + socket.remotePort;
      const mac = createHmac("sha256", Buffer.from(nonce, "base64url")).update(domain).digest("base64url");
      socket.write("Hue-setup-owned:" + mac + "\\n");
      let data = "", done = false;
      socket.on("data", chunk => {
        data += chunk.toString();
        if (!done && data.includes("\\r\\n\\r\\n")) {
          done = true; calls++;
          socket.end("HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\nConnection: close\\r\\n\\r\\n1\\r\\nx\\r\\n0\\r\\n\\r\\n");
        }
      });
    });
    await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
    try {
      const port = server.address().port;
      const socket = await connectOwnedApplication(port,nonce,()=>true,1000);
      if (calls !== 0) throw new Error("premature_request");
      await requestOwnedApplication(socket,new URL("http://127.0.0.1:"+port+"/owned"),1000);
      if (calls !== 1 || connections !== 1) throw new Error("replayed_request");
      process.stdout.write("passed\\n");
    } catch { process.stderr.write("socket_check_failed\\n"); process.exitCode = 1; }
    await new Promise(resolve => server.close(resolve));
  `;
  const result = spawnSync("node", ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8192,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("passed\n");
  expect(result.stderr).toBe("");
});
