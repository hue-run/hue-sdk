import { sceneContext } from "./context.js";
import { randomUUID } from "node:crypto";
import { validateOptions } from "../config.js";
import {
  ARTIFACT_BYTES,
  MANIFEST_BYTES,
  ScenesApiError,
  sha256,
  canonical,
  SnapshotMissError,
} from "./portable.js";
import type { BlobRef, ScenesOptions, Snapshot, Manifest } from "./types.js";
export async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new ScenesApiError();
      chunks.push(part.value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class ScenesClient {
  readonly options: ScenesOptions;
  readonly baseUrl: string;
  private fetcher: typeof fetch;
  private timeout: number;
  private queuedBytes = 0;
  private queuedRecords = 0;
  private uploads = 0;
  private waiters: (() => void)[] = [];
  constructor(options: ScenesOptions) {
    if (typeof options.capture !== "boolean")
      throw new TypeError(
        "Scene capture must be explicitly enabled or disabled",
      );
    const o = validateOptions({
      ...options,
      serviceName: "hue-scenes",
      captureContent: false,
    });
    this.baseUrl = o.baseUrl;
    this.timeout = o.timeoutMillis;
    for (const [name, value] of Object.entries({
      maxQueueBytes: options.maxQueueBytes ?? 64 * 1024 * 1024,
      maxQueueRecords: options.maxQueueRecords ?? 2048,
    })) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError(`Invalid ${name}`);
    }
    this.options = Object.freeze({ ...options });
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    Object.defineProperty(this, "options", { enumerable: false });
  }
  reserve(bytes: number, records = 0): boolean {
    if (
      this.queuedBytes + bytes >
        (this.options.maxQueueBytes ?? 64 * 1024 * 1024) ||
      this.queuedRecords + records > (this.options.maxQueueRecords ?? 2048)
    )
      return false;
    this.queuedBytes += bytes;
    this.queuedRecords += records;
    return true;
  }
  release(bytes: number, records = 0) {
    this.queuedBytes -= bytes;
    this.queuedRecords -= records;
  }
  private network(input: string | URL, init: RequestInit) {
    const context = sceneContext.getStore();
    return context
      ? sceneContext.run({ ...context, suppressed: true }, () =>
          this.fetcher(input, init),
        )
      : this.fetcher(input, init);
  }
  issue(kind: string, count = 1) {
    try {
      this.options.onIssue?.({ kind, count });
    } catch {
      /* User reporting must not affect application. */
    }
  }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      const encoded = body === undefined ? undefined : canonical(body);
      if (encoded && Buffer.byteLength(encoded) > 1048576)
        throw new ScenesApiError();
      response = await this.network(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          ...(encoded ? { "Content-Type": "application/json" } : {}),
        },
        body: encoded,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ScenesApiError(response.status);
      }
      return JSON.parse(
        Buffer.from(await readBounded(response, MANIFEST_BYTES)).toString(),
      ) as T;
    } catch (e) {
      if (e instanceof ScenesApiError) throw e;
      throw new ScenesApiError();
    }
  }
  async upload(
    bytes: Uint8Array,
    mimeType: string,
    filename = "scene-payload",
    purpose: "source" | "scene_payload" = "scene_payload",
  ): Promise<BlobRef> {
    if (bytes.byteLength > ARTIFACT_BYTES)
      throw new RangeError("Artifact exceeds 25 MiB");
    if (this.uploads >= 2) await new Promise<void>((r) => this.waiters.push(r));
    else this.uploads++;
    try {
      const info = await this.request<{ id: string }>("POST", "/artifacts", {
        idempotencyKey: randomUUID(),
        filename,
        contentType: mimeType,
        byteSize: bytes.byteLength,
        sha256: sha256(bytes),
        purpose,
      });
      const target = await this.request<{
        uploadUrl: string;
        method: string;
        headers: Record<string, string>;
        expiresAt: string;
      }>("POST", `/artifacts/${encodeURIComponent(info.id)}/upload`, {});
      if (target.method !== "PUT") throw new ScenesApiError();
      const url = new URL(target.uploadUrl);
      if (
        url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )
      )
        throw new ScenesApiError();
      const r = await this.network(url, {
        method: "PUT",
        headers: target.headers,
        body: new Uint8Array(bytes),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw new ScenesApiError(r.status);
      }
      await r.body?.cancel();
      const complete = await this.request<{
        state: string;
        verifiedBytes: number;
        verifiedSha256: string;
      }>("POST", `/artifacts/${encodeURIComponent(info.id)}/complete`, {});
      if (
        complete.state !== "ready" ||
        complete.verifiedBytes !== bytes.byteLength ||
        complete.verifiedSha256 !== sha256(bytes)
      )
        throw new ScenesApiError();
      return {
        artifactId: info.id,
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
        mimeType,
        encoding: "bytes",
      };
    } catch (e) {
      if (e instanceof ScenesApiError || e instanceof RangeError) throw e;
      throw new ScenesApiError();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.uploads--;
    }
  }
  async download(ref: BlobRef): Promise<Uint8Array> {
    if (ref.byteSize > ARTIFACT_BYTES)
      throw new SnapshotMissError("unavailable_content");
    let r: Response;
    try {
      r = await this.network(
        `${this.baseUrl}/api/v1/artifacts/${encodeURIComponent(ref.artifactId)}/download`,
        {
          headers: { Authorization: `Bearer ${this.options.apiKey}` },
          redirect: "error",
          signal: AbortSignal.timeout(this.timeout),
        },
      );
    } catch {
      throw new SnapshotMissError("unavailable_content");
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new SnapshotMissError("unavailable_content");
    }
    const bytes = await readBounded(r, ARTIFACT_BYTES);
    if (bytes.byteLength !== ref.byteSize || sha256(bytes) !== ref.sha256)
      throw new SnapshotMissError("integrity");
    return bytes;
  }

  getRevision(pin: Snapshot) {
    return this.request<{ manifest: Manifest; digest: string }>(
      "GET",
      `/scenes/${encodeURIComponent(pin.sceneId)}/revisions/${pin.revision}`,
    );
  }
}
