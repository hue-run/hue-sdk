import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const installedPackage = dirname(
  createRequire(import.meta.url).resolve("@hue-run/sdk/package.json"),
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hue-setup-port-"));
  directories.push(root);
  return root;
}

test("an occupied random-port candidate does not prevent the owned application request", async () => {
  const root = await directory();
  const modulePath = join(installedPackage, "dist/setup/application.js");
  const storeModulePath = join(installedPackage, "dist/setup/installation.js");
  const serverSource = `
    import { createServer } from "node:net";
    import { createHmac } from "node:crypto";
    import { appendFileSync, writeFileSync } from "node:fs";
    createServer(socket => {
      const domain = "hue-setup-owned-v1\\0" + socket.localPort + "\\0" + socket.remotePort;
      const mac = createHmac("sha256", Buffer.from(process.env.HUE_SETUP_SOCKET_PROOF, "base64url")).update(domain).digest("base64url");
      socket.write("Hue-setup-owned:" + mac + "\\n");
      let request = "", done = false;
      socket.on("data", data => {
        request += data.toString();
        if (!done && request.includes("\\r\\n\\r\\n")) {
          done = true;
          appendFileSync("handler-count.txt", "1");
          writeFileSync(process.env.HUE_SETUP_EVIDENCE_FILE, JSON.stringify({source:"existing-application-request",traceId:"1".repeat(32),spanId:"2".repeat(16),credentialVersion:0}), {mode:0o600});
          socket.end("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok");
        }
      });
    }).listen(Number(process.env.PORT), "127.0.0.1");
  `;
  await writeFile(join(root, "server.mjs"), serverSource);
  const script = `
    import crypto from "node:crypto";
    import { syncBuiltinESMExports } from "node:module";
    import { createServer } from "node:net";
    import { readFile } from "node:fs/promises";
    const sockets = new Set();
    let foreignBytes = 0;
    const foreign = createServer(socket => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("data", data => { foreignBytes += data.length; });
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise(resolve => foreign.listen(0, "127.0.0.1", resolve));
    const original = crypto.randomInt;
    crypto.randomInt = () => foreign.address().port;
    syncBuiltinESMExports();
    try {
      const { exerciseSetupApplication } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      const { FileSetupInstallationStore } = await import(${JSON.stringify(pathToFileURL(storeModulePath).href)});
      const store = new FileSetupInstallationStore(${JSON.stringify(root)}, "https://example.test");
      const record = await store.loadOrCreate();
      record.credential = {apiKey:"hue_setup_test_setup-"+"a".repeat(24)+"_"+"s".repeat(43),keyId:"setup-"+"a".repeat(24),version:0,kind:"anonymous_trial",capabilities:["setup_telemetry_write"]};
      await store.save(record);
      const evidence = await exerciseSetupApplication(store, record, {
        language:"typescript",manager:"npm",framework:"express",entrypoint:"server.mjs",requestPath:"/",entryDigest:"a".repeat(64),
      }, undefined, {readinessMillis:3000,requestMillis:1000,evidenceMillis:1000});
      const calls = await readFile(${JSON.stringify(join(root, "handler-count.txt"))}, "utf8");
      if (calls !== "1" || foreignBytes !== 0 || evidence.source !== "existing-application-request") throw new Error("request boundary failed");
      process.stdout.write("verified once; foreign listener untouched\\n");
    } catch { process.exitCode = 1; }
    finally {
      crypto.randomInt = original;
      syncBuiltinESMExports();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => foreign.close(resolve));
    }
  `;
  const result = spawnSync("node", ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8192,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("verified once; foreign listener untouched\n");
  expect(result.stderr).toBe("");
});
