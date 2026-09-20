import { Agent, request } from "node:http";
import { createConnection, type Socket } from "node:net";
import { createHmac } from "node:crypto";

/** Private attempt framing, never an HTTP header or public event. */
export function setupSocketPreface(nonce: string, serverPort: number, clientPort: number): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce))
    throw new Error("Invalid application ownership challenge");
  const digest = createHmac("sha256", Buffer.from(nonce, "base64url"))
    .update(`hue-setup-owned-v1\0${serverPort}\0${clientPort}`)
    .digest("base64url");
  return Buffer.from(`Hue-setup-owned:${digest}\n`, "ascii");
}

/** Connect without sending anything; only the launched app knows this attempt's proof. */
export async function connectOwnedApplication(
  port: number,
  nonce: string,
  stillRunning: () => boolean,
  timeoutMillis: number,
  signal?: AbortSignal,
): Promise<Socket> {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Setup interrupted");
    if (!stillRunning()) throw new Error("The application exited before verification");
    const owned = await new Promise<Socket | undefined>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let settled = false;
      let received = Buffer.alloc(0);
      let expected: Buffer | undefined;
      const finish = (success: boolean, refused = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.removeAllListeners();
        if (success && stillRunning()) {
          socket.pause();
          // A peer reset between authentication and request creation must not be unhandled.
          socket.on("error", () => undefined);
          resolve(socket);
        } else {
          socket.destroy();
          if (refused) resolve(undefined);
          else
            reject(
              new Error("The application socket did not prove ownership; no HTTP request was sent"),
            );
        }
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, Math.max(1, Math.min(500, deadline - Date.now())));
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        expected = setupSocketPreface(nonce, socket.remotePort!, socket.localPort!);
      });
      socket.on("data", (data: Buffer) => {
        if (!expected || data.length > expected.length - received.length) {
          finish(false);
          return;
        }
        received = Buffer.concat([received, data]);
        if (
          received.length > expected.length ||
          !expected.subarray(0, received.length).equals(received)
        )
          finish(false);
        else if (received.length === expected.length) finish(true);
      });
      socket.once("error", (error: NodeJS.ErrnoException) =>
        finish(false, !expected && error.code === "ECONNREFUSED"),
      );
      socket.once("end", abort);
      socket.once("close", abort);
    });
    if (owned) return owned;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))),
    );
  }
  throw new Error("The application did not prove socket ownership within the setup deadline");
}

/** One HTTP request on exactly the authenticated connection. Never dial, redirect or retry. */
export async function requestOwnedApplication(
  socket: Socket,
  url: URL,
  timeoutMillis: number,
  signal?: AbortSignal,
): Promise<void> {
  if (socket.destroyed || socket.readableEnded || !socket.writable || signal?.aborted) {
    socket.destroy();
    throw new Error("The owned application connection closed before its request");
  }
  const agent = new Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1 });
  let assigned = false;
  agent.createConnection = () => {
    if (assigned || socket.destroyed)
      throw new Error("Refusing an application connection replacement");
    assigned = true;
    return socket;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const done = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const fail = () =>
        done(new Error("The single application request did not complete; it will not be replayed"));
      const outgoing = request(url, { agent, method: "GET", maxHeaderSize: 16 * 1024 });
      const abort = () => {
        outgoing.destroy();
        fail();
      };
      const timer = setTimeout(abort, timeoutMillis);
      signal?.addEventListener("abort", abort, { once: true });
      outgoing.once("socket", (actual) => {
        if (actual !== socket) {
          actual.destroy();
          abort();
        }
      });
      outgoing.once("error", fail);
      outgoing.once("response", (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          done(
            new Error(
              "The selected application handler did not return a successful response; it will not be replayed",
            ),
          );
          return;
        }
        let bytes = 0;
        response.on("data", (data: Buffer) => {
          bytes += data.length;
          if (bytes > 1024 * 1024) abort();
        });
        response.once("error", fail);
        response.once("aborted", fail);
        response.once("end", () => done());
      });
      outgoing.end();
      socket.resume();
      if (signal?.aborted) abort();
    });
  } finally {
    agent.destroy();
    socket.destroy();
  }
}
