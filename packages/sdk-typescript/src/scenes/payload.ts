import type { Payload } from "./types.js";
import {
  ARTIFACT_BYTES,
  INLINE_BYTES,
  canonical,
  json,
  SnapshotMissError,
} from "./portable.js";
import { ScenesClient } from "./api.js";
export type PortableValue = undefined | Uint8Array | ReturnType<typeof json>;
export function copyValue(value: unknown): PortableValue {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) {
    if (value.byteLength > ARTIFACT_BYTES) throw new RangeError("Payload cap");
    return new Uint8Array(value);
  }
  const v = json(value);
  if (Buffer.byteLength(canonical(v)) > ARTIFACT_BYTES)
    throw new RangeError("Payload cap");
  return v;
}
export function valueSize(value: PortableValue): number {
  return value === undefined
    ? 0
    : value instanceof Uint8Array
      ? value.byteLength
      : Buffer.byteLength(canonical(value));
}
export async function encodePayload(
  client: ScenesClient,
  value: PortableValue,
): Promise<Payload> {
  if (value === undefined) return { kind: "absent" };
  const binary = value instanceof Uint8Array;
  const bytes = binary ? value : Buffer.from(canonical(value));
  if (
    (binary ? Math.ceil(bytes.byteLength / 3) * 4 : bytes.byteLength) <=
    INLINE_BYTES
  )
    return binary
      ? { kind: "bytes", base64: Buffer.from(bytes).toString("base64") }
      : { kind: "json", value };
  const ref = await client.upload(
    bytes,
    binary ? "application/octet-stream" : "application/json",
  );
  return { kind: "blob", ref: { ...ref, encoding: binary ? "bytes" : "json" } };
}
export async function decodePayload(
  client: Pick<ScenesClient, "download">,
  payload: Payload,
): Promise<unknown> {
  switch (payload.kind) {
    case "absent":
      return undefined;
    case "json": {
      const value = json(payload.value);
      if (Buffer.byteLength(canonical(value)) > INLINE_BYTES)
        throw new SnapshotMissError("integrity");
      return value;
    }
    case "bytes": {
      if (
        payload.base64.length > INLINE_BYTES ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          payload.base64,
        )
      )
        throw new SnapshotMissError("integrity");
      return new Uint8Array(Buffer.from(payload.base64, "base64"));
    }
    case "blob": {
      const bytes = await client.download(payload.ref);
      if (payload.ref.encoding === "json") {
        try {
          return json(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          );
        } catch {
          throw new SnapshotMissError("integrity");
        }
      }
      return payload.ref.encoding === "utf8"
        ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        : bytes;
    }
    case "stream":
      return Promise.all(payload.items.map((p) => decodePayload(client, p)));
    case "http": {
      const body = await decodePayload(client, payload.body);
      if (!(body instanceof Uint8Array))
        throw new SnapshotMissError("integrity");
      return { ...payload, body };
    }
  }
}
