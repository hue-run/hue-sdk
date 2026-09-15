import { ClientRequestInterceptor } from "@mswjs/interceptors/ClientRequest";
import { HttpRequestInterceptor } from "@mswjs/interceptors/http";
import { ClientRequest, type IncomingMessage } from "node:http";
import { readBounded } from "./scenes/api.js";
import type { Playback } from "./scenes/playback.js";
import { CaptureSession } from "./scenes/capture.js";
import { sceneContext } from "./scenes/context.js";
import {
  httpArguments,
  httpBinding,
  HttpCapture,
  replayHttpResponse,
} from "./scenes/http.js";
import {
  ARTIFACT_BYTES,
  cleanHeaders,
  cleanUrl,
  SnapshotMissError,
} from "./scenes/portable.js";
let installed = false;
/** Explicit process installation. Only registered HTTP bindings inside a Scenes async scope are intercepted. */
export function installNodeHttpCapture(): { dispose(): void } {
  if (installed)
    throw new TypeError("Hue Node HTTP interceptor is already installed");
  installed = true;
  const entrypoints = new ClientRequestInterceptor();
  const interceptor = new HttpRequestInterceptor();
  interceptor.on("request", async ({ request, initiator, controller }) => {
    const active = sceneContext.getStore();
    if (!active || active.suppressed) return;
    let binding;
    try {
      binding = httpBinding(active.runtime, request.url);
    } catch (e) {
      if (active.runtime.mode === "playback") controller.errorWith(e as Error);
      else
        (active.runtime as CaptureSession).client.issue(
          "overlapping_http_bindings",
        );
      return;
    }
    if (!binding || !active.runtime.selected(binding.id)) return;
    let args: unknown,
      eligible = true;
    try {
      const length = request.headers.get("content-length");
      if (
        (request.body &&
          (!length ||
            !/^\d+$/.test(length) ||
            Number(length) > ARTIFACT_BYTES)) ||
        request.headers.has("transfer-encoding") ||
        request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("multipart/")
      )
        throw new TypeError();
      const bytes = request.body
        ? await readBounded(new Response(request.clone().body), ARTIFACT_BYTES)
        : new Uint8Array();
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
      try {
        if (!eligible)
          (active.runtime as Playback).reject(
            binding.id,
            "http",
            args,
            "nonportable",
          );
        controller.respondWith(
          replayHttpResponse(active.runtime as Playback, binding, args),
        );
      } catch (e) {
        controller.errorWith(
          e instanceof Error ? e : new SnapshotMissError("nonportable"),
        );
      }
      return;
    }
    const native =
      initiator instanceof ClientRequest
        ? initiator
        : (initiator as { _httpMessage?: unknown })?._httpMessage;
    const capture = active.runtime as CaptureSession,
      handle = capture.begin(binding.id, "http", args);
    if (!eligible && handle) handle.replayable = false;
    if (!(native instanceof ClientRequest)) {
      capture.finishPayload(
        handle,
        async () => ({ kind: "absent" }),
        0,
        false,
        "unknown_http_client",
      );
      return;
    }
    native.once("error", (e) => capture.fail(handle, e));
    native.prependOnceListener("response", (response: IncomingMessage) => {
      try {
        const headers = cleanHeaders(
          Object.fromEntries(
            Object.entries(response.headers).flatMap(([k, v]) =>
              v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v]],
            ),
          ),
        );
        delete headers["transfer-encoding"];
        const observer = new HttpCapture(capture, handle, {
          kind: "http",
          status: response.statusCode ?? 0,
          statusText: response.statusMessage,
          headers,
          url: cleanUrl(request.url),
        });
        const push = response.push;
        // Native push obeys IncomingMessage backpressure; no second Response branch or eager body reader.
        response.push = function (chunk: unknown, encoding?: BufferEncoding) {
          if (chunk === null) observer.finish();
          else if (chunk instanceof Uint8Array) observer.chunk(chunk);
          else if (typeof chunk === "string")
            observer.chunk(Buffer.from(chunk, encoding));
          return push.call(this, chunk, encoding);
        };
        response.once("aborted", () =>
          observer.fail(new Error("Aborted"), true),
        );
        response.once("error", (e) => observer.fail(e));
        response.once("close", () => {
          if (!response.complete)
            observer.fail(new Error("Incomplete response"), true);
        });
      } catch {
        capture.finishPayload(
          handle,
          async () => ({ kind: "absent" }),
          0,
          false,
          "unsupported_http_response",
        );
      }
    });
  });
  entrypoints.apply();
  interceptor.apply();
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      interceptor.dispose();
      entrypoints.dispose();
      installed = false;
    },
  };
}
