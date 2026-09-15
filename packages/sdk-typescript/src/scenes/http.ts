import { randomUUID } from "node:crypto";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import type { Playback } from "./playback.js";
import { CaptureSession } from "./capture.js";
import { sceneContext, type SceneRuntime } from "./context.js";
import { encodePayload } from "./payload.js";
import {
  ARTIFACT_BYTES,
  canonical,
  cleanHeaders,
  cleanUrl,
  sanitize,
  sha256,
  SnapshotMissError,
} from "./portable.js";
import type { Binding, HttpPayload } from "./types.js";
export const SEMANTIC_HEADERS = [
  "accept",
  "content-type",
  "range",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "if-range",
];
function isJsonContentType(value: string | null | undefined): boolean {
  const mediaType = value?.split(";")[0].trim().toLowerCase() ?? "";
  return (
    mediaType === "application/json" ||
    /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+\+json$/.test(mediaType)
  );
}
export function httpBinding(
  runtime: SceneRuntime,
  url: string,
): Binding | undefined {
  const u = new URL(url);
  const bindings = runtime.bindings.filter(
    (b) =>
      runtime.selected(b.id) &&
      b.kind === "http" &&
      b.http?.origin === u.origin &&
      u.pathname.startsWith(b.http.pathPrefix),
  );
  if (bindings.length > 1) throw new SnapshotMissError("overlapping_bindings");
  return bindings[0];
}
export function httpArguments(
  binding: Binding,
  request: Request,
  bytes: Uint8Array,
) {
  let body = bytes;
  if (isJsonContentType(request.headers.get("content-type")) && bytes.length) {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    body = Buffer.from(canonical(sanitize(JSON.parse(decoded)).value));
  }
  return {
    method: request.method.toUpperCase(),
    url: cleanUrl(request.url),
    headers: cleanHeaders(request.headers, [
      ...SEMANTIC_HEADERS,
      ...(binding.http?.headers ?? []).map((h) => h.toLowerCase()),
    ]),
    bodySha256: sha256(body),
  };
}
async function fetchBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Uint8Array> {
  const b = init?.body;
  if (b === undefined || b === null) {
    if (input instanceof Request && input.body)
      throw new TypeError(
        "Streaming Request bodies require an enclosing source tool",
      );
    return new Uint8Array();
  }
  if (typeof b === "string" || b instanceof URLSearchParams)
    return Buffer.from(String(b));
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b))
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (b instanceof Blob && b.size <= ARTIFACT_BYTES)
    return new Uint8Array(await b.arrayBuffer());
  throw new TypeError("Streaming and multipart requests are not portable");
}
type CaptureHandle = ReturnType<CaptureSession["begin"]>;
/** Bounded accumulator; capturing never drains a response that the application has not consumed. */
export class HttpCapture {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private eligible = true;
  private ended = false;
  constructor(
    readonly capture: CaptureSession,
    readonly handle: CaptureHandle,
    readonly metadata: Omit<HttpPayload, "body">,
  ) {}
  chunk(value: Uint8Array) {
    if (!this.eligible || this.ended) return;
    try {
      if (
        this.size + value.byteLength > ARTIFACT_BYTES ||
        !this.capture.client.reserve(value.byteLength)
      )
        throw new Error();
      this.size += value.byteLength;
      this.chunks.push(new Uint8Array(value));
    } catch {
      this.disable();
    }
  }
  private disable() {
    this.eligible = false;
    this.capture.client.release(this.size);
    this.size = 0;
    this.chunks = [];
  }
  finish() {
    if (this.ended) return;
    this.ended = true;
    try {
      const bytes = new Uint8Array(Buffer.concat(this.chunks));
      if (
        this.eligible &&
        bytes.length > 0 &&
        isJsonContentType(this.metadata.headers["content-type"])
      ) {
        try {
          if (
            sanitize(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  decompress(bytes, this.metadata.headers["content-encoding"]),
                ),
              ),
            ).changed
          )
            this.eligible = false;
        } catch {
          this.eligible = false;
        }
      }
      this.capture.client.release(this.size);
      this.size = 0;
      this.chunks = [];
      this.capture.finishPayload(
        this.handle,
        async () => {
          let body;
          const mime =
            this.metadata.headers["content-type"]?.split(";")[0].trim() ??
            "application/octet-stream";
          if (
            this.eligible &&
            bytes.length > 0 &&
            this.metadata.status >= 200 &&
            this.metadata.status < 300 &&
            (mime === "application/pdf" ||
              mime ===
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
              mime ===
                "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
              this.metadata.headers["content-disposition"]
                ?.toLowerCase()
                .includes("attachment"))
          ) {
            const sourceBytes = decompress(
              bytes,
              this.metadata.headers["content-encoding"],
            );
            const ref = await this.capture.client.upload(
              sourceBytes,
              mime,
              "source",
              "source",
            );
            void this.capture.source({
              id: randomUUID(),
              relation: "tool_source",
              reference: ref,
              callId: this.handle?.callId,
              mimeType: mime,
              ...(this.metadata.url ? { uri: this.metadata.url } : {}),
              content: this.metadata.status === 206 ? "partial" : "complete",
            });
            body = this.metadata.headers["content-encoding"]
              ? await encodePayload(this.capture.client, bytes)
              : { kind: "blob" as const, ref };
          } else body = await encodePayload(this.capture.client, bytes);
          return { ...this.metadata, body };
        },
        bytes.length,
        this.eligible,
        this.eligible ? undefined : "http_body_cap_or_redacted",
      );
    } catch {
      this.disable();
      this.capture.finishPayload(
        this.handle,
        async () => ({ kind: "absent" }),
        0,
        false,
        "unsupported_http_response",
      );
    }
  }
  fail(error: unknown, cancelled = false) {
    if (this.ended) return;
    this.ended = true;
    this.disable();
    // The application has already received an HTTP response. A function-level error
    // cannot reproduce its headers or partially consumed body during playback.
    if (this.handle) this.handle.replayable = false;
    this.capture.fail(this.handle, error, cancelled);
  }
}
export function responseMetadata(
  response: Response,
  decoded = true,
): Omit<HttpPayload, "body"> {
  const headers = cleanHeaders(response.headers);
  delete headers["transfer-encoding"];
  if (
    decoded &&
    response.body &&
    headers["content-encoding"] &&
    headers["content-encoding"] !== "identity"
  ) {
    delete headers["content-encoding"];
    delete headers["content-length"];
  }
  return {
    kind: "http",
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(response.url ? { url: cleanUrl(response.url) } : {}),
  };
}
function decompress(bytes: Uint8Array, encoding?: string): Uint8Array {
  switch (encoding?.toLowerCase()) {
    case undefined:
    case "identity":
      return bytes;
    case "gzip":
      return gunzipSync(bytes, { maxOutputLength: ARTIFACT_BYTES });
    case "deflate":
      return inflateSync(bytes, { maxOutputLength: ARTIFACT_BYTES });
    case "br":
      return brotliDecompressSync(bytes, { maxOutputLength: ARTIFACT_BYTES });
    default:
      throw new SnapshotMissError("nonportable");
  }
}
export function responseFromRecorded(
  value: unknown,
  decoded = false,
  head = false,
): Response {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "http" ||
    !("body" in value) ||
    !(value.body instanceof Uint8Array)
  )
    throw new SnapshotMissError("incompatible");
  const p = value as unknown as Omit<HttpPayload, "body"> & {
    body: Uint8Array;
  };
  if (p.status < 200 || p.status > 599)
    throw new SnapshotMissError("nonportable");
  const headers = { ...p.headers };
  const transformed =
    decoded &&
    !head &&
    p.body.length > 0 &&
    Boolean(headers["content-encoding"]) &&
    headers["content-encoding"] !== "identity";
  const body = transformed
    ? decompress(p.body, headers["content-encoding"])
    : p.body;
  if (transformed) {
    delete headers["content-encoding"];
    delete headers["content-length"];
  }
  const response = new Response(
    head || [204, 205, 304].includes(p.status) ? null : new Uint8Array(body),
    { status: p.status, statusText: p.statusText, headers },
  );
  if (p.url) Object.defineProperty(response, "url", { value: p.url });
  return response;
}
export function wrapFetch(
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  const wrapped: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const active = sceneContext.getStore();
    if (!active || active.suppressed) return fetcher(input, init);
    const request =
      input instanceof Request
        ? new Request(input.url, {
            method: init?.method ?? input.method,
            headers: init?.headers ?? input.headers,
            signal: init?.signal ?? input.signal,
            ...(init?.body ? { body: init.body } : {}),
          })
        : new Request(input, init);
    const binding = httpBinding(active.runtime, request.url);
    if (!binding || !active.runtime.selected(binding.id))
      return fetcher(input, init);
    let args: unknown;
    let eligible = true;
    try {
      if (
        request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("multipart/")
      )
        throw new TypeError();
      const bytes = await fetchBody(input, init);
      if (bytes.length > ARTIFACT_BYTES) throw new TypeError();
      args = httpArguments(binding, request, bytes);
    } catch {
      eligible = false;
      args = {
        method: request.method,
        url: cleanUrl(request.url),
        unsupportedBody: true,
      };
    }
    if (active.runtime.mode === "playback") {
      if (!eligible)
        (active.runtime as Playback).reject(
          binding.id,
          "http",
          args,
          "nonportable",
        );
      return responseFromRecorded(
        active.runtime.invoke(binding.id, "http", args, () => {
          throw new SnapshotMissError("unrecorded");
        }),
        true,
        request.method === "HEAD",
      );
    }
    const capture = active.runtime as CaptureSession;
    const handle = capture.begin(binding.id, "http", args);
    if (!eligible && handle) handle.replayable = false;
    let response: Response;
    try {
      response = await sceneContext.run(
        { ...active, parentCallId: handle?.callId, suppressed: true },
        () => fetcher(input, init),
      );
    } catch (e) {
      capture.fail(handle, e, request.signal.aborted);
      throw e;
    }
    try {
      const observer = new HttpCapture(
        capture,
        handle,
        responseMetadata(response),
      );
      if (!response.body) {
        observer.finish();
        return response;
      }
      if (response.status < 200 || response.status > 599) {
        observer.fail(new Error("Unsupported status"), true);
        return response;
      }
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const part = await reader.read();
              if (part.done) {
                observer.finish();
                controller.close();
                reader.releaseLock();
              } else {
                observer.chunk(part.value);
                controller.enqueue(part.value);
              }
            } catch (e) {
              observer.fail(e);
              controller.error(e);
              reader.releaseLock();
            }
          },
          async cancel(reason) {
            observer.fail(reason, true);
            try {
              await reader.cancel(reason);
            } finally {
              reader.releaseLock();
            }
          },
        },
        { highWaterMark: 0 },
      );
      const wrapped = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperties(wrapped, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      });
      return wrapped;
    } catch {
      capture.finishPayload(
        handle,
        async () => ({ kind: "absent" }),
        0,
        false,
        "unsupported_http_response",
      );
      return response;
    }
  }) as typeof fetch;
  return wrapped;
}
