/**
 * Spec for a server-chosen artifact upload URL when the evaluation origin is not loopback.
 *
 * The upload may proceed only when the URL is https, has no userinfo or fragment, and its
 * parsed hostname is exactly the origin hostname. An IP literal, and every address a name
 * resolves to, must be public: not in 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
 * 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3,
 * ::/128, ::1/128, 64:ff9b::/96, fc00::/7, fe80::/10, fec0::/10, or ff00::/8, with an
 * IPv4-mapped IPv6 address judged as its IPv4 address. A name is resolved once and the PUT
 * connects to one of those addresses; a later lookup must not receive the bytes. The PUT
 * body is the file, the signed path and query are unchanged, and the only headers added are
 * the file content-type and, when the capability grants it, `x-vercel-blob-access: private`.
 * The Hue credential is not sent. No connection is opened when the URL is refused.
 *
 * These tests fail while a non-loopback origin still PUTs to loopback or to any other https host.
 *
 * The same accept-any-https-or-loopback-http check is also in `cli/world.ts` and
 * `cli/traces-import-upload.ts`, and in the Python blob uploader. Those callers are not
 * exercised here. Python managed output files call the same `_upload_url` as
 * `upload_artifact_bytes`, which `test_artifact_upload_target.py` does exercise.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const root = join(import.meta.dir, "..");
const driver = join(import.meta.dir, "artifact-upload-target.driver.ts");
const pinDriver = join(import.meta.dir, "artifact-upload-pin.driver.ts");

function privateIpv4(): string {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
  throw new Error("This test needs a non-loopback IPv4 address to receive an arbitrary https PUT");
}

async function certificate(
  directory: string,
  names: string[],
): Promise<{ cert: string; key: string }> {
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  const subjectAltName = names
    .map((name) => (/^[0-9.]+$/.test(name) || name.includes(":") ? `IP:${name}` : `DNS:${name}`))
    .join(",");
  const proc = Bun.spawn(
    [
      "openssl",
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
      "/CN=upload-target",
      "-addext",
      `subjectAltName=${subjectAltName}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  return { cert, key };
}

interface Operation {
  name: string;
  error: string | null;
  hits: { where: string; body: string }[];
  apiReached: boolean | null;
}

test("a non-loopback origin does not PUT file bytes to a server-chosen host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-upload-target-"));
  const privateIp = privateIpv4();
  try {
    const { cert, key } = await certificate(directory, ["127.0.0.1", "::1", privateIp]);
    const child = Bun.spawn([process.execPath, driver], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: cert,
        UPLOAD_TARGET_CERT: cert,
        UPLOAD_TARGET_KEY: key,
        UPLOAD_TARGET_PRIVATE_IP: privateIp,
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(stderr || stdout);
    const report = JSON.parse(stdout) as { operations: Operation[] };
    const refused = (operation: Operation) =>
      operation.name.startsWith("uploadArtifact") || operation.name === "requestArtifactUpload";
    const open = report.operations.filter(
      (operation) =>
        operation.hits.length > 0 ||
        operation.apiReached === false ||
        (refused(operation) && operation.error !== "HueApiError"),
    );
    expect(open).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("an allowlisted upload name is connected to the first public address only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-upload-pin-"));
  const built = join(directory, "pin-driver.mjs");
  const names = [
    "evil.example",
    "loop.hue.test",
    "storage.hue.test",
    "evil2.example",
    "loop2.hue.test",
    "storage2.hue.test",
  ];
  try {
    const { cert, key } = await certificate(directory, ["127.0.0.1", "203.0.113.10", ...names]);
    const build = Bun.spawn(["bun", "build", pinDriver, "--target=node", "--outfile", built], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
    const harness = join(import.meta.dir, "artifact-upload-pin.harness.py");
    const child = Bun.spawn(
      [
        "unshare",
        "--user",
        "--map-root-user",
        "--net",
        "--mount",
        "python3",
        harness,
        "node",
        cert,
        key,
        built,
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: process.env.PATH ?? "" },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(stderr || stdout);
    const report = JSON.parse(stdout) as {
      node: { evil: string; loop: string; pin: string };
      hits: {
        where: string;
        path: string;
        body: string;
        authorization: string | null;
        blob: string | null;
        type: string | null;
      }[];
    };
    const bodyOf = (path: string) => report.hits.filter((hit) => hit.path.startsWith(path));
    expect(bodyOf("/evil")).toEqual([]);
    expect(bodyOf("/loop")).toEqual([]);
    expect(report.node.evil).toBe("HueApiError");
    expect(report.node.loop).toBe("HueApiError");
    const pinned = bodyOf("/pinned");
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.where).toBe("public");
    expect(pinned[0]?.body).toBe("pinned-file-bytes");
    expect(pinned[0]?.path).toBe("/pinned?sig=keep");
    expect(pinned[0]?.type).toBe("text/plain");
    expect(pinned[0]?.blob).toBe("private");
    expect(pinned[0]?.authorization).toBeNull();
    expect(report.node.pin).toBe("sent");
    expect(report.hits.filter((hit) => hit.where === "loop")).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
