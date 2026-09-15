import type { HueClient } from "../client.js";
import type { JsonValue } from "../types.js";
export type { JsonValue } from "../types.js";
export interface BlobRef {
  artifactId: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  encoding: "bytes" | "json" | "utf8";
}
export type Payload =
  | { kind: "absent" }
  | { kind: "json"; value: JsonValue }
  | { kind: "bytes"; base64: string }
  | { kind: "blob"; ref: BlobRef }
  | { kind: "stream"; items: Payload[] }
  | HttpPayload;
export interface HttpPayload {
  kind: "http";
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  url?: string;
  body: Payload;
}
export interface Operation {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  kind?: "tool" | "resource";
}
export interface Binding {
  id: string;
  kind: "tool" | "mcp" | "http";
  contractVersion: string;
  operations?: Operation[];
  accountScope?: string;
  http?: { origin: string; pathPrefix: string; headers?: string[] };
}
export interface Source {
  id: string;
  artifactId?: string;
  content: "complete" | "partial" | "reference_only" | "unavailable";
  relation: "query_attachment" | "tool_source";
  name?: string;
  mimeType?: string;
  byteSize?: number;
  sha256?: string;
  uri?: string;
  callId?: string;
  sourceVersion?: string;
  metadata?: JsonValue;
}
export interface Observation {
  id: string;
  callId: string;
  producerId: string;
  sequence: number;
  phase: "start" | "finish";
  bindingId: string;
  operation: string;
  contractVersion: string;
  requestKey: string;
  arguments?: Payload;
  parentCallId?: string;
  externalSpanId?: string;
  at: string;
  outcome?: "success" | "error" | "cancelled" | "incomplete";
  result?: Payload;
  error?: { type: string; message?: string; code?: JsonValue };
  sources?: Source[];
  replayable: boolean;
  omissionReason?: string;
}
export interface Producer {
  producerId: string;
  lastSequence: number;
  pending: number;
  dropped: number;
}
export interface Manifest {
  schemaVersion: "1";
  capturePolicy?: { sourceContent: true; redactionVersion: "1" };
  sceneId: string;
  projectId: string;
  revision: number;
  externalTraceId: string;
  sessionId?: string;
  observedUserId?: string;
  input?: Payload;
  bindings: Binding[];
  observations: Observation[];
  sources: Source[];
  producers: Producer[];
  createdAt: string;
}
export interface Snapshot {
  sceneId: string;
  revision: number;
  digest: string;
}
export interface ReplayEvent {
  id: string;
  sequence: number;
  callId?: string;
  bindingId: string;
  operation: string;
  requestKey: string;
  status: "matched" | "miss" | "error";
  reason?: string;
  recordedCallId?: string;
  at: string;
}
export type MissReason =
  | "unrecorded"
  | "exhausted"
  | "incompatible"
  | "ambiguous"
  | "incomplete"
  | "unavailable_content"
  | "nonportable"
  | "overlapping_bindings"
  | "integrity";
export interface ScenesOptions {
  apiKey: string;
  baseUrl?: string;
  capture: boolean;
  hue?: HueClient;
  fetch?: typeof fetch;
  timeoutMillis?: number;
  maxQueueBytes?: number;
  maxQueueRecords?: number;
  onIssue?: (issue: { kind: string; count: number }) => void;
}
export interface CaptureOptions {
  bindings: Binding[];
  externalTraceId?: string;
  sessionId?: string;
  observedUserId?: string;
  input?: JsonValue;
  producerId?: string;
  idempotencyKey?: string;
}
