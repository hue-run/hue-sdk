import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("media grants from a non-loopback origin are not fetched", () => {
  const dir = mkdtempSync(join(tmpdir(), "hue-media-grant-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=hue-media-api.test",
      "-addext",
      "subjectAltName=DNS:hue-media-api.test,DNS:media.evil.test,IP:127.0.0.1,IP:127.0.0.2",
    ],
    { encoding: "utf8" },
  );
  if (made.status !== 0) throw new Error(made.stderr || "openssl failed");
  const child = spawnSync(
    process.env.NODE ?? "node",
    ["--test", join(import.meta.dir, "media-grant-ssrf.cases.mjs")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: cert,
        HUE_MEDIA_GRANT_CERT: cert,
        HUE_MEDIA_GRANT_KEY: key,
      },
    },
  );
  if (child.status !== 0) {
    throw new Error(`node --test exited ${child.status}\n${child.stdout}\n${child.stderr}`);
  }
}, 30_000);
