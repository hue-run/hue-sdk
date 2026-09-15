import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { ScenesClient } from "./api.js";
import {
  ARTIFACT_BYTES,
  canonical,
  cleanUrl,
  json,
  requestKey,
  sanitize,
  ScenesApiError,
  validateBindings,
} from "./portable.js";
import {
  copyValue,
  encodePayload,
  valueSize,
  type PortableValue,
} from "./payload.js";
import {
  isAsyncIterable,
  isPromise,
  sceneContext,
  type SceneRuntime,
} from "./context.js";
import type {
  Binding,
  BlobRef,
  CaptureOptions,
  Observation,
  Payload,
  Snapshot,
  Source,
} from "./types.js";
interface Handle {
  binding: Binding;
  operation: string;
  callId: string;
  requestKey: string;
  parentCallId?: string;
  externalSpanId?: string;
  replayable: boolean;
  finished: boolean;
}
export class CaptureSession implements SceneRuntime {
  readonly mode = "capture" as const;
  readonly bindings: Binding[];
  readonly producerId: string;
  readonly sceneId: string;
  private sequence = 0;
  private revision: number;
  private tail = Promise.resolve();
  private tasks = 0;
  private bytes = 0;
  private pending = 0;
  private dropped = 0;
  private calls = 0;
  private constructor(
    readonly client: ScenesClient,
    options: CaptureOptions,
    remote: { id: string; captureRevision: number },
  ) {
    this.bindings = validateBindings(options.bindings);
    this.producerId = options.producerId ?? randomUUID();
    this.sceneId = remote.id;
    this.revision = remote.captureRevision;
  }
  static async create(
    client: ScenesClient,
    options: CaptureOptions,
  ): Promise<CaptureSession> {
    if (!client.options.capture)
      throw new TypeError("Scene capture is disabled");
    const bindings = validateBindings(options.bindings);
    const externalTraceId =
      options.externalTraceId ??
      (client.options.hue
        ? trace.getSpanContext(client.options.hue.getContext())?.traceId
        : undefined);
    if (!externalTraceId || !/^(?!0{32})[a-f0-9]{32}$/.test(externalTraceId))
      throw new TypeError(
        "A valid Hue trace context or externalTraceId is required",
      );
    const producerId = options.producerId ?? randomUUID();
    const input =
      options.input === undefined
        ? undefined
        : await encodePayload(client, sanitize(options.input).value);
    const body = {
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      externalTraceId,
      bindings,
      producerId,
      capturePolicy: { sourceContent: true, redactionVersion: "1" },
      startedAt: new Date().toISOString(),
      ...(input ? { input } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.observedUserId
        ? { observedUserId: options.observedUserId }
        : {}),
    };
    const remote = await client.request<{
      id: string;
      captureRevision: number;
    }>("POST", "/scenes", body);
    return new CaptureSession(
      client,
      { ...options, bindings, producerId },
      remote,
    );
  }
  selected(id: string) {
    return this.bindings.some((b) => b.id === id);
  }
  run<T>(callback: () => T): T {
    return sceneContext.run({ runtime: this }, callback);
  }
  private enqueue(
    build: () => Promise<Observation | Source>,
    size: number,
    source = false,
  ) {
    if (!this.client.reserve(size, 1)) {
      this.dropped++;
      this.client.issue("dropped");
      return;
    }
    this.tasks++;
    this.bytes += size;
    this.tail = this.tail.then(async () => {
      try {
        const record = await build();
        const response = await this.client.request<{ captureRevision: number }>(
          "POST",
          `/scenes/${encodeURIComponent(this.sceneId)}/${source ? "sources" : "observations"}`,
          {
            idempotencyKey: record.id,
            [source ? "sources" : "observations"]: [record],
          },
        );
        this.revision = response.captureRevision;
      } catch {
        this.dropped++;
        this.client.issue("failed");
      } finally {
        this.tasks--;
        this.bytes -= size;
        this.client.release(size, 1);
      }
    });
  }
  begin(
    bindingId: string,
    operation: string,
    args: unknown,
  ): Handle | undefined {
    const binding = this.bindings.find((b) => b.id === bindingId);
    if (!binding) return;
    try {
      if (++this.calls > 2000) {
        this.dropped++;
        this.client.issue("call_limit");
        return;
      }
      let value: PortableValue,
        replayable = true;
      try {
        value = sanitize(args).value;
      } catch {
        value = null;
        replayable = false;
      }
      const h: Handle = {
        binding,
        operation,
        callId: randomUUID(),
        requestKey: requestKey(binding, operation, value),
        parentCallId: sceneContext.getStore()?.parentCallId,
        externalSpanId: this.client.options.hue
          ? trace.getSpanContext(this.client.options.hue.getContext())?.spanId
          : trace.getActiveSpan()?.spanContext().spanId,
        replayable,
        finished: false,
      };
      const sequence = this.sequence++;
      const at = new Date().toISOString();
      this.pending++;
      this.enqueue(
        async () => ({
          ...this.base(h, sequence, at),
          phase: "start",
          arguments: await encodePayload(this.client, value),
          ...(!replayable ? { omissionReason: "unsupported_arguments" } : {}),
        }),
        valueSize(value),
      );
      return h;
    } catch {
      this.dropped++;
      this.client.issue("invalid");
      return;
    }
  }
  private base(h: Handle, sequence: number, at: string) {
    return {
      id: randomUUID(),
      callId: h.callId,
      producerId: this.producerId,
      sequence,
      bindingId: h.binding.id,
      operation: h.operation,
      contractVersion: h.binding.contractVersion,
      requestKey: h.requestKey,
      at,
      replayable: h.replayable,
      ...(h.parentCallId ? { parentCallId: h.parentCallId } : {}),
      ...(h.externalSpanId ? { externalSpanId: h.externalSpanId } : {}),
    };
  }
  finishPayload(
    h: Handle | undefined,
    build: () => Promise<Payload>,
    size: number,
    replayable = true,
    omissionReason?: string,
  ) {
    if (!h || h.finished) return;
    h.finished = true;
    this.pending--;
    const sequence = this.sequence++,
      at = new Date().toISOString();
    this.enqueue(async () => {
      let result: Payload | undefined;
      let omission = omissionReason;
      try {
        if (replayable) result = await build();
      } catch {
        replayable = false;
        omission = "unavailable_content";
      }
      return {
        ...this.base(h, sequence, at),
        phase: "finish",
        outcome: replayable ? "success" : "incomplete",
        replayable: h.replayable && replayable,
        ...(result ? { result } : {}),
        ...(omission ? { omissionReason: omission } : {}),
      };
    }, size);
  }
  private finish(h: Handle | undefined, result: unknown) {
    if (!h) return;
    try {
      if (
        h.binding.kind === "mcp" &&
        result &&
        typeof result === "object" &&
        "resultType" in result &&
        result.resultType !== "accepted"
      )
        throw new TypeError("Unsupported MCP continuation");
      let v = copyValue(result);
      let changed = false;
      if (v !== undefined && !(v instanceof Uint8Array)) {
        const safe = sanitize(v);
        v = safe.value;
        changed = safe.changed;
      }
      if (h.binding.kind === "mcp") this.mcpSources(h, v);
      this.finishPayload(
        h,
        () => encodePayload(this.client, v),
        valueSize(v),
        !changed,
        changed ? "redacted_result" : undefined,
      );
    } catch {
      this.finishPayload(
        h,
        async () => ({ kind: "absent" }),
        0,
        false,
        "unsupported_result",
      );
    }
  }
  fail(h: Handle | undefined, error: unknown, cancelled = false) {
    if (!h || h.finished) return;
    h.finished = true;
    this.pending--;
    const sequence = this.sequence++;
    const at = new Date().toISOString();
    const type = error instanceof Error ? error.name : "Error";
    this.enqueue(
      async () => ({
        ...this.base(h, sequence, at),
        phase: "finish",
        outcome: cancelled ? "cancelled" : "error",
        error: { type },
        replayable: h.replayable && !cancelled,
      }),
      0,
    );
  }
  invoke<T>(
    bindingId: string,
    operation: string,
    args: unknown,
    execute: () => T,
  ): T {
    const h = this.begin(bindingId, operation, args);
    const active = {
      runtime: this,
      parentCallId: h?.callId ?? sceneContext.getStore()?.parentCallId,
    };
    const finish = (value: unknown): unknown => {
      if (isAsyncIterable(value)) return this.captureIterable(h, value, active);
      this.finish(h, value);
      return value;
    };
    return sceneContext.run(active, () => {
      try {
        const value = execute();
        if (isPromise(value))
          return Promise.resolve(value).then(finish, (e) => {
            this.fail(h, e);
            throw e;
          }) as T;
        return finish(value) as T;
      } catch (e) {
        this.fail(h, e);
        throw e;
      }
    });
  }
  private captureIterable(
    h: Handle | undefined,
    original: AsyncIterable<unknown>,
    active: { runtime: SceneRuntime; parentCallId?: string },
  ): AsyncIterable<unknown> {
    const self = this;
    let used = false;
    const tracked = {
      [Symbol.asyncIterator]() {
        if (used) throw new TypeError("Captured stream is single-use");
        used = true;
        const iterator = original[Symbol.asyncIterator]();
        const items: PortableValue[] = [];
        let size = 0,
          eligible = true,
          done = false;
        return {
          async next(...args: [] | [unknown]) {
            try {
              if (args.length && args[0] !== undefined) {
                eligible = false;
                self.client.release(size);
                size = 0;
                items.length = 0;
              }

              const result = await sceneContext.run(active, () =>
                iterator.next(...args),
              );
              if (result.done) {
                done = true;
                if (result.value !== undefined) eligible = false;
                self.client.release(size);
                const queuedSize = size;
                size = 0;
                self.finishPayload(
                  h,
                  async () => ({
                    kind: "stream",
                    items: await Promise.all(
                      items.map((x) => encodePayload(self.client, x)),
                    ),
                  }),
                  queuedSize,
                  eligible,
                  eligible ? undefined : "stream_cap_or_unsupported",
                );
              } else if (eligible) {
                try {
                  let item = copyValue(result.value);
                  if (item !== undefined && !(item instanceof Uint8Array)) {
                    const safe = sanitize(item);
                    if (safe.changed) throw new Error();
                    item = safe.value;
                  }
                  const added = valueSize(item);
                  if (
                    items.length >= 2000 ||
                    size + added > ARTIFACT_BYTES ||
                    !self.client.reserve(added)
                  )
                    throw new Error();
                  size += added;
                  items.push(item);
                } catch {
                  eligible = false;
                  items.length = 0;
                  self.client.release(size);
                  size = 0;
                }
              }
              return result;
            } catch (e) {
              done = true;
              self.client.release(size);
              size = 0;
              self.fail(h, e, true);
              throw e;
            }
          },
          async throw(error?: unknown) {
            if (!done) {
              done = true;
              eligible = false;
              self.client.release(size);
              size = 0;
              items.length = 0;
              self.fail(h, error, true);
            }
            if (iterator.throw)
              return sceneContext.run(active, () => iterator.throw!(error));
            throw error;
          },
          async return(value?: unknown) {
            if (!done) {
              done = true;
              self.client.release(size);
              size = 0;
              self.fail(h, new Error("Cancelled"), true);
            }
            return iterator.return
              ? await sceneContext.run(active, () => iterator.return!(value))
              : { done: true, value: undefined };
          },
        };
      },
    };
    let iterator: AsyncIterator<unknown> | undefined;
    const get = () => (iterator ??= tracked[Symbol.asyncIterator]());
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(...args: [] | [unknown]) {
        return get().next(...args);
      },
      return(value?: unknown) {
        const current = get();
        return current.return
          ? current.return(value)
          : Promise.resolve({ done: true as const, value });
      },
      throw(error?: unknown) {
        const current = get();
        return current.throw ? current.throw(error) : Promise.reject(error);
      },
    } as AsyncIterableIterator<unknown>;
  }

  private mcpSources(h: Handle, value: PortableValue) {
    if (
      !value ||
      typeof value !== "object" ||
      value instanceof Uint8Array ||
      Array.isArray(value)
    )
      return;
    const objects: unknown[] = [];
    if (Array.isArray(value.contents)) objects.push(...value.contents);
    if (Array.isArray(value.content))
      for (const c of value.content)
        if (
          c &&
          typeof c === "object" &&
          !Array.isArray(c) &&
          c.type === "resource"
        )
          objects.push(c.resource);
    for (const item of objects.slice(0, 200)) {
      try {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        if (typeof r.uri !== "string") continue;
        let bytes: Uint8Array | undefined;
        if (typeof r.blob === "string") {
          if (
            r.blob.length > (ARTIFACT_BYTES * 4) / 3 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              r.blob,
            )
          )
            continue;
          bytes = new Uint8Array(Buffer.from(r.blob, "base64"));
        } else if (typeof r.text === "string") bytes = Buffer.from(r.text);
        if (bytes)
          void this.source({
            id: randomUUID(),
            uri: r.uri,
            callId: h.callId,
            relation: "tool_source",
            mimeType:
              typeof r.mimeType === "string" ? r.mimeType : "text/plain",
            bytes,
          });
      } catch {
        this.client.issue("invalid_mcp_source");
      }
    }
  }
  async source(
    source: Omit<Source, "artifactId" | "sha256" | "byteSize" | "content"> & {
      bytes?: Uint8Array;
      reference?: BlobRef;
      content?: Source["content"];
    },
  ): Promise<void> {
    try {
      if (!["query_attachment", "tool_source"].includes(source.relation))
        throw new TypeError();
      const { bytes, reference, ...metadata } = source;
      if (bytes && reference) throw new TypeError();
      const safe = sanitize({
        ...metadata,
        ...(source.uri ? { uri: cleanUrl(source.uri) } : {}),
      }).value as unknown as Source;
      const copy = bytes ? new Uint8Array(bytes) : undefined;
      this.enqueue(
        async () => {
          if (reference)
            return {
              ...safe,
              content: source.content ?? "complete",
              artifactId: reference.artifactId,
              sha256: reference.sha256,
              byteSize: reference.byteSize,
            };
          if (!copy)
            return {
              ...safe,
              content:
                source.content === "unavailable"
                  ? "unavailable"
                  : "reference_only",
            };
          const ref = await this.client.upload(
            copy,
            source.mimeType ?? "application/octet-stream",
            source.name ?? "source",
            "source",
          );
          return {
            ...safe,
            content: source.content ?? "complete",
            artifactId: ref.artifactId,
            sha256: ref.sha256,
            byteSize: ref.byteSize,
          };
        },
        copy?.byteLength ?? 0,
        true,
      );
    } catch {
      this.dropped++;
      this.client.issue("invalid_source");
    }
  }
  async flush(): Promise<{ pending: number; dropped: number }> {
    let drained: Promise<void>;
    do {
      drained = this.tail;
      await drained;
    } while (drained !== this.tail);
    return { pending: this.pending + this.tasks, dropped: this.dropped };
  }
  async finalize(timeoutMillis = 30000): Promise<Snapshot> {
    if (
      !Number.isFinite(timeoutMillis) ||
      timeoutMillis < 0 ||
      timeoutMillis > 60000
    )
      throw new TypeError("Finalize timeout must be 0–60000 milliseconds");
    const deadline = Date.now() + timeoutMillis;
    while ((this.tasks || this.pending) && Date.now() < deadline) {
      await new Promise((r) =>
        setTimeout(r, Math.min(10, Math.max(0, deadline - Date.now()))),
      );
    }
    const seal = () =>
      this.client.request<Snapshot>(
        "POST",
        `/scenes/${encodeURIComponent(this.sceneId)}/finalize`,
        {
          idempotencyKey: randomUUID(),
          expectedCaptureRevision: this.revision,
          producers: [
            {
              producerId: this.producerId,
              lastSequence: Math.max(0, this.sequence - 1),
              pending: this.pending + this.tasks,
              dropped: this.dropped,
            },
          ],
          endedAt: new Date().toISOString(),
        },
      );
    try {
      return await seal();
    } catch (error) {
      if (!(error instanceof ScenesApiError) || error.status !== 409)
        throw error;
      const current = await this.client.request<{ captureRevision: number }>(
        "GET",
        `/scenes/${encodeURIComponent(this.sceneId)}`,
      );
      if (
        !Number.isSafeInteger(current.captureRevision) ||
        current.captureRevision < this.revision
      )
        throw error;
      this.revision = current.captureRevision;
      return seal();
    }
  }
}
