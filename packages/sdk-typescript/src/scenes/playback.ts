import { randomUUID } from "node:crypto";
import { ScenesClient } from "./api.js";
import {
  canonical,
  json,
  RecordedToolError,
  requestKey,
  sanitize,
  sha256,
  SnapshotMissError,
  verifyManifest,
} from "./portable.js";
import { decodePayload } from "./payload.js";
import { sceneContext, type SceneRuntime } from "./context.js";
import type {
  Binding,
  Manifest,
  Observation,
  ReplayEvent,
  Snapshot,
  MissReason,
  Payload,
} from "./types.js";
interface Entry {
  start: Observation;
  finish?: Observation;
  value?: unknown;
  failure?: MissReason;
  fingerprint?: string;
}
export class Playback implements SceneRuntime {
  readonly mode = "playback" as const;
  readonly bindings: Binding[];
  readonly events: ReplayEvent[] = [];
  private queues = new Map<string, Entry[]>();
  private cursors = new Map<string, number>();
  private ambiguous = new Set<string>();
  private selectedIds: Set<string>;
  private eventSequence = 0;
  private reported = 0;
  private completion?: Promise<unknown>;
  private flushing?: Promise<void>;
  private replayIdValue = "";
  get replayId() {
    return this.replayIdValue;
  }
  private constructor(
    readonly manifest: Manifest,
    readonly client: ScenesClient,
    selected: string[],
  ) {
    this.bindings = manifest.bindings;
    this.selectedIds = new Set(selected);
  }
  static async load(
    client: ScenesClient,
    pin: Snapshot,
    selected: string[],
    externalTraceId = randomUUID().replaceAll("-", ""),
  ): Promise<Playback> {
    const response = await client.getRevision(pin);
    if (response.digest !== pin.digest)
      throw new SnapshotMissError("integrity");
    const manifest = verifyManifest(response.manifest, pin.digest);
    if (manifest.sceneId !== pin.sceneId || manifest.revision !== pin.revision)
      throw new SnapshotMissError("integrity");
    return this.fromManifest(client, manifest, selected, externalTraceId);
  }
  static async fromManifest(
    client: ScenesClient,
    manifest: Manifest,
    selected: string[],
    externalTraceId = randomUUID().replaceAll("-", ""),
  ): Promise<Playback> {
    manifest = verifyManifest(manifest, sha256(canonical(manifest)));
    if (
      new Set(selected).size !== selected.length ||
      selected.some((id) => !manifest.bindings.some((b) => b.id === id))
    )
      throw new SnapshotMissError("incompatible");
    const starts = new Map<string, Observation>();
    const sequences = new Set<string>();
    const finishes = new Map<string, Observation>();
    const ids = new Map<string, string>();
    for (const o of manifest.observations) {
      const fingerprint = canonical(o);
      if (ids.has(o.id)) {
        if (ids.get(o.id) !== fingerprint)
          throw new SnapshotMissError("integrity");
        continue;
      }
      ids.set(o.id, fingerprint);
      const sequence = `${o.producerId}:${o.sequence}`;
      if (sequences.has(sequence)) throw new SnapshotMissError("integrity");
      sequences.add(sequence);
      const map = o.phase === "start" ? starts : finishes;
      if (map.has(o.callId)) throw new SnapshotMissError("integrity");
      map.set(o.callId, o);
    }
    const selections = new Set(selected);
    for (const s of starts.values()) {
      if (!selections.has(s.bindingId)) continue;
      let p = s.parentCallId;
      const visited = new Set<string>([s.callId]);
      while (p) {
        if (visited.has(p)) throw new SnapshotMissError("integrity");
        visited.add(p);
        const parent = starts.get(p);
        if (!parent) break;
        if (selections.has(parent.bindingId))
          throw new SnapshotMissError("overlapping_bindings");
        p = parent.parentCallId;
      }
    }
    const self = new Playback(manifest, client, [...selections]);
    let loadedBytes = 0;
    for (const start of starts.values()) {
      if (!selections.has(start.bindingId)) continue;
      const finish = finishes.get(start.callId);
      const entry: Entry = { start, finish };
      const binding = manifest.bindings.find((b) => b.id === start.bindingId);
      if (!binding || binding.contractVersion !== start.contractVersion)
        throw new SnapshotMissError("integrity");
      if (
        finish &&
        (finish.requestKey !== start.requestKey ||
          finish.bindingId !== start.bindingId ||
          finish.operation !== start.operation ||
          finish.contractVersion !== start.contractVersion ||
          finish.producerId !== start.producerId ||
          finish.sequence <= start.sequence)
      )
        throw new SnapshotMissError("integrity");
      try {
        if (!start.arguments) throw new SnapshotMissError("incomplete");
        const args = await decodePayload(client, start.arguments);
        if (requestKey(binding, start.operation, args) !== start.requestKey)
          throw new SnapshotMissError("integrity");
        if (
          !finish ||
          !finish.outcome ||
          !start.replayable ||
          !finish.replayable ||
          finish.outcome === "cancelled" ||
          finish.outcome === "incomplete"
        )
          entry.failure = "incomplete";
        else if (finish.outcome === "success") {
          if (!finish.result) throw new SnapshotMissError("incomplete");
          loadedBytes += payloadBytes(finish.result);
          if (loadedBytes > 64 * 1024 * 1024)
            throw new SnapshotMissError("unavailable_content");
          if (binding.kind === "http" && finish.result.kind !== "http")
            throw new SnapshotMissError("incompatible");
          entry.value = await decodePayload(client, finish.result);
        }
      } catch (e) {
        entry.failure =
          e instanceof SnapshotMissError ? e.reason : "unavailable_content";
      }
      entry.fingerprint = sha256(
        canonical({
          outcome: finish?.outcome ?? "incomplete",
          error: finish?.error ?? null,
          failure: entry.failure ?? null,
          kind:
            finish?.result?.kind === "stream"
              ? "stream"
              : finish?.result?.kind === "http"
                ? "http"
                : "value",
          value: semanticValue(entry.value),
        }),
      );
      const q = self.queues.get(start.requestKey) ?? [];
      q.push(entry);
      self.queues.set(start.requestKey, q);
    }
    for (const [key, q] of self.queues) {
      q.sort(
        (a, b) =>
          a.start.producerId.localeCompare(b.start.producerId) ||
          a.start.sequence - b.start.sequence,
      );
      for (let i = 0; i < q.length; i++)
        for (let j = i + 1; j < q.length; j++) {
          const a = q[i],
            b = q[j];
          const overlap =
            a.start.producerId !== b.start.producerId ||
            !a.finish ||
            a.finish.sequence > b.start.sequence;
          if (overlap && a.fingerprint !== b.fingerprint)
            self.ambiguous.add(key);
        }
    }
    const replay = await client.request<{ id: string }>(
      "POST",
      "/scene-replays",
      {
        idempotencyKey: randomUUID(),
        sceneId: manifest.sceneId,
        revision: manifest.revision,
        bindingIds: selected,
        externalTraceId,
      },
    );
    self.replayIdValue = replay.id;
    return self;
  }
  selected(id: string) {
    return this.selectedIds.has(id);
  }
  run<T>(callback: () => T): T {
    return sceneContext.run({ runtime: this }, callback);
  }
  invoke<T>(
    bindingId: string,
    operation: string,
    args: unknown,
    _execute: () => T,
  ): T {
    const binding = this.bindings.find((b) => b.id === bindingId);
    if (!this.selected(bindingId)) return _execute();
    let key = sha256("unsupported");
    const miss = (reason: MissReason): never => {
      this.record(bindingId, operation, key, "miss", undefined, reason);
      throw new SnapshotMissError(reason, bindingId, operation);
    };
    if (!binding) return miss("incompatible");
    try {
      key = requestKey(binding, operation, sanitize(args).value);
    } catch {
      return miss("nonportable");
    }
    if (this.ambiguous.has(key)) return miss("ambiguous");
    const queue = this.queues.get(key);
    if (!queue) return miss("unrecorded");
    const index = this.cursors.get(key) ?? 0;
    const entry = queue[index];
    if (!entry) return miss("exhausted");
    this.cursors.set(key, index + 1);
    if (entry.failure) return miss(entry.failure);
    const finish = entry.finish!;
    if (finish.outcome === "error") {
      this.record(bindingId, operation, key, "error", entry.start.callId);
      throw new RecordedToolError(
        finish.error?.type ?? "Error",
        finish.error?.code,
      );
    }
    this.record(bindingId, operation, key, "matched", entry.start.callId);
    if (finish.result?.kind === "stream") {
      const items = entry.value as unknown[];
      return (async function* () {
        for (const item of items) yield cloneDecoded(item);
      })() as T;
    }
    return cloneDecoded(entry.value) as T;
  }
  reject(
    bindingId: string,
    operation: string,
    args: unknown,
    reason: MissReason,
  ): never {
    let key = sha256("unsupported");
    const binding = this.bindings.find((b) => b.id === bindingId);
    try {
      if (binding) key = requestKey(binding, operation, sanitize(args).value);
    } catch {}
    this.record(bindingId, operation, key, "miss", undefined, reason);
    throw new SnapshotMissError(reason, bindingId, operation);
  }
  private record(
    bindingId: string,
    operation: string,
    key: string,
    status: ReplayEvent["status"],
    recordedCallId?: string,
    reason?: string,
  ) {
    if (this.events.length >= 4000) {
      this.client.issue("replay_event_limit");
      return;
    }
    this.events.push({
      id: randomUUID(),
      sequence: this.eventSequence++,
      bindingId,
      operation,
      requestKey: key,
      status,
      at: new Date().toISOString(),
      ...(recordedCallId ? { recordedCallId } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushEvents().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  private async flushEvents() {
    while (this.reported < this.events.length) {
      const events = this.events.slice(this.reported, this.reported + 200);
      await this.client.request(
        "POST",
        `/scene-replays/${encodeURIComponent(this.replayId)}/events`,
        { idempotencyKey: sha256(canonical(events)), events },
      );
      this.reported += events.length;
    }
  }
  complete(
    state: "completed" | "failed" | "interrupted" = "completed",
  ): Promise<unknown> {
    if (this.completion) return this.completion;
    this.completion = (async () => {
      await this.flush();
      return this.client.request(
        "POST",
        `/scene-replays/${encodeURIComponent(this.replayId)}/complete`,
        {
          idempotencyKey: randomUUID(),
          state,
          endedAt: new Date().toISOString(),
        },
      );
    })();
    return this.completion;
  }
}
function cloneDecoded(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(cloneDecoded);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, cloneDecoded(v)]),
    );
  return value;
}
function payloadBytes(p: Payload): number {
  switch (p.kind) {
    case "blob":
      return p.ref.byteSize;
    case "bytes":
      return Math.floor((p.base64.length * 3) / 4);
    case "json":
      return Buffer.byteLength(canonical(p.value));
    case "http":
      return payloadBytes(p.body);
    case "stream":
      return p.items.reduce((n, p) => n + payloadBytes(p), 0);
    default:
      return 0;
  }
}
export const loadPlayback = Playback.load.bind(Playback);

function semanticValue(value: unknown): unknown {
  if (value === undefined) return ["absent"];
  if (value instanceof Uint8Array)
    return ["bytes", sha256(value), value.byteLength];
  if (Array.isArray(value)) return ["array", value.map(semanticValue)];
  if (value && typeof value === "object")
    return [
      "object",
      Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, semanticValue(v)]),
      ),
    ];
  return ["scalar", value];
}
