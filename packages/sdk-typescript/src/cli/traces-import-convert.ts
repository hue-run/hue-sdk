import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod/v4";
import { blobEntry, blobPrefix, BLOBS_KEY, MAX_BLOB_ENTRIES, textContentType } from "../blobs.js";
import { TRUNCATED_KEY } from "../privacy.js";
import { hueSpanId, hueTraceId } from "./langfuse.js";
import { isZipSignature } from "./traces-import-zip.js";

/**
 * The conversions behind `hue traces import prepare`: a source file is recognized by its content
 * (an OTLP/JSON trace export, a complete Langfuse observation export or a text ATIF export),
 * each trace becomes OTLP/JSON entries, one span each, that keep the recorded ids, hierarchy,
 * timestamps, content, errors and usage, and the entries are packed into deterministic gzip
 * batches. Nothing here depends on where a file sat or what it was called: a renamed or repacked
 * bundle converts to byte-identical batches, so the manifest's digests name the same import.
 */

export const traceImportFormats = ["otlp_json", "langfuse_observations", "atif"] as const;
export type TraceImportFormat = (typeof traceImportFormats)[number];
export const traceImportOrigins = ["production", "evaluation", "simulation", "unknown"] as const;
export type TraceImportOrigin = (typeof traceImportOrigins)[number];

/** The bounds the import routes hold a manifest to. */
export const traceImportLimits = {
  traces: 10_000,
  batchesPerTrace: 64,
  blobsPerTrace: 1_000,
  spansPerTrace: 100_000,
  manifestBytes: 8 * 1024 * 1024,
  batchBytes: 4 * 1024 * 1024,
  blobBytes: 1_000_000_000,
} as const;

/** One batch, decoded, and on the wire: well inside the receiver's request bounds. */
export const MAX_BATCH_DECODED_BYTES = 3 * 1024 * 1024;
export const MAX_BATCH_WIRE_BYTES = 900 * 1024;
/** The largest value a record keeps inline; a longer text is stored apart from its span. */
export const MAX_INLINE_VALUE_BYTES = 1024 * 1024;
export const SOURCE_RECORD = "hue.import.source_record";
export const SOURCE_ENVELOPE = "hue.import.source_envelope";
const BATCH_PREFIX = '{"resourceSpans":[';
const BATCH_SUFFIX = "]}";
const BATCH_FRAME_BYTES = BATCH_PREFIX.length + BATCH_SUFFIX.length;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const BASE64_TRACE_ID = /^[A-Za-z0-9+/]{22}==$/;
const BASE64_SPAN_ID = /^[A-Za-z0-9+/]{11}=$/;
const MAX_IDENTIFIER = 16_384;
const MAX_SESSION = 2_048;
const MAX_NAMESPACE = 128;
/** The root attributes Hue reads a trace's user, session and explicit entity from. */
const USER_KEYS = [
  "user.id",
  "enduser.id",
  "hue.user.id",
  "ai.telemetry.metadata.userId",
  "langfuse.user.id",
];
const SESSION_KEYS = [
  "gen_ai.conversation.id",
  "session.id",
  "hue.session.id",
  "ai.telemetry.metadata.sessionId",
  "langfuse.session.id",
];
const ENTITY_NAMESPACE = "hue.world.entity.namespace";
const ENTITY_ID = "hue.world.entity.id";
/** Attributes that mark a trace as an evaluation's or a simulated world's. */
const EVALUATION_KEYS = ["hue.execution.id", "hue.eval.execution_id"];
const SIMULATION_KEYS = ["hue.world.id", "hue.environment.run_id"];
const SIMULATION_SCOPE = "hue.sim-gateway";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface OtlpValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpValue[] };
  kvlistValue?: { values: OtlpAttribute[] };
  bytesValue?: string;
}
export interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}
export type ImportSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
};
/** One resource group holding one scope group holding one span: the unit the packer serializes.
 * A converted span is an {@link ImportSpan}; an OTLP/JSON span is kept as recorded. */
export interface ImportEntry {
  [key: string]: unknown;
  scopeSpans: { [key: string]: unknown; spans: Record<string, unknown>[] }[];
}
export interface TraceIdentity {
  user?: string;
  entity?: { namespace: string; id: string };
  session?: string;
}
export interface PreparedBlob {
  sha256: string;
  byteSize: number;
  contentType: string;
  bytes: Uint8Array;
}
export interface ConvertedTrace {
  traceId: string;
  format: TraceImportFormat;
  entries: ImportEntry[];
  blobs: PreparedBlob[];
  identity?: TraceIdentity;
  origin: TraceImportOrigin;
  /** The SHA-256 of every source file that held part of the trace. */
  sourceDigests: Set<string>;
  remappedTraceId: boolean;
  remappedSpans: number;
}
/** A trace, span or file that was not converted, and why. */
export interface Refusal {
  traceId?: string;
  reason: string;
}

export class ConversionError extends Error {}

export const sha256Hex = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const digestHex = (text: string, length: number) => sha256Hex(text).slice(0, length);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Record<string, JsonValue> {
  if (!isObject(value)) throw new ConversionError("Expected a source JSON object");
  return value as Record<string, JsonValue>;
}

/** An identifier Hue keeps as a history owner or session: nonempty, bounded, well formed. */
function identifier(value: unknown, max: number): string | undefined {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    !value.includes("\0") &&
    value.isWellFormed()
    ? value
    : undefined;
}

// --- JSON reading ------------------------------------------------------------------------------

const LONG_INTEGER = /\d{16}/;

/**
 * JSON text parsed with every integer too large for a JavaScript number kept as its decimal
 * text, so an OTLP timestamp written as a number keeps its nanoseconds. `unsafeIntegers` says
 * whether any was found; the Langfuse and ATIF readers refuse such a file, as Hue's do.
 */
export function parseJsonText(text: string): { value: unknown; unsafeIntegers: boolean } {
  if (!LONG_INTEGER.test(text)) return { value: JSON.parse(text), unsafeIntegers: false };
  let unsafeIntegers = false;
  const reviver = (_key: string, value: unknown, context?: { source?: string }) => {
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      typeof context?.source === "string" &&
      /^-?\d+$/.test(context.source)
    ) {
      unsafeIntegers = true;
      return context.source;
    }
    return value;
  };
  try {
    return {
      value: JSON.parse(text, reviver as (key: string, value: unknown) => unknown),
      unsafeIntegers,
    };
  } catch (error) {
    // The reviver walks recursively; a body nested too deep for it is read without it.
    if (error instanceof RangeError) return { value: JSON.parse(text), unsafeIntegers: false };
    throw error;
  }
}

/** Refuses a source value that JavaScript or OTLP cannot retain exactly; never omits it. */
export function validateSource(value: JsonValue, depth = 0): void {
  if (depth > 64) throw new ConversionError("Source JSON exceeds the nesting bound");
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new ConversionError("Source JSON contains an unsafe number");
  } else if (typeof value === "string") {
    if (!value.isWellFormed() || value.includes("\u0000"))
      throw new ConversionError("Source JSON contains invalid text");
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      validateSource(key, depth + 1);
      validateSource(child, depth + 1);
    }
  }
}

/** Compares decimal values without rounding, allowing harmless exponent and zero formatting. */
function decimalIdentity(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new ConversionError("JSON has unsafe numbers");
  const digits = match[2]! + (match[3] ?? "");
  let start = 0;
  let end = digits.length;
  while (start < end && digits[start] === "0") start++;
  if (start === end) return `${match[1]}0`;
  while (digits[end - 1] === "0") end--;
  const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0) + digits.length - end;
  if (!Number.isSafeInteger(exponent)) throw new ConversionError("JSON has unsafe numbers");
  return `${match[1]}${digits.slice(start, end)}e${exponent}`;
}

/** JSON.parse otherwise loses duplicate members and can round decimal argument values. */
export function validateJsonText(raw: string): void {
  const stack: ({ keys: Set<string>; expectingKey: boolean } | null)[] = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "{") stack.push({ keys: new Set(), expectingKey: true });
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === ",") {
      const current = stack.at(-1);
      if (current) current.expectingKey = true;
    } else if (char === '"') {
      const start = i;
      for (i++; i < raw.length; i++) {
        if (raw[i] === "\\") i++;
        else if (raw[i] === '"') break;
      }
      const current = stack.at(-1);
      if (current?.expectingKey) {
        const key = JSON.parse(raw.slice(start, i + 1)) as string;
        if (current.keys.has(key)) throw new ConversionError("JSON has duplicate object keys");
        current.keys.add(key);
        current.expectingKey = false;
      }
    } else if (char === "-" || (char! >= "0" && char! <= "9")) {
      const start = i;
      while (i + 1 < raw.length && /[\d.eE+-]/.test(raw[i + 1]!)) i++;
      const original = raw.slice(start, i + 1);
      if (decimalIdentity(original) !== decimalIdentity(JSON.stringify(Number(original))))
        throw new ConversionError("JSON has unsafe numbers");
    }
  }
}

// --- Detection ---------------------------------------------------------------------------------

export type DetectedSource =
  | { format: "otlp_json"; envelopes: Record<string, unknown>[] }
  | {
      format: "langfuse_observations";
      observations: Record<string, JsonValue>[];
      envelope: Record<string, JsonValue>;
      unsafeIntegers: boolean;
    }
  | { format: "atif"; text: string; document: unknown; unsafeIntegers: boolean }
  | { format: "unsupported"; reason: string };

const isOtlpEnvelope = (value: unknown): boolean =>
  isObject(value) && (Array.isArray(value.resourceSpans) || Array.isArray(value.resource_spans));

const isObservation = (value: unknown): value is Record<string, JsonValue> =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.traceId === "string" &&
  typeof value.type === "string" &&
  typeof value.startTime === "string";

/** What a file holds, read from its content alone; never from its name. */
export function detectFormat(bytes: Uint8Array): DetectedSource {
  if (!bytes.byteLength) return { format: "unsupported", reason: "the file is empty" };
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    return { format: "unsupported", reason: "a gzip file; decompress it first" };
  // An archive is read where the walk finds it on disk; one inside another is not opened.
  if (isZipSignature(bytes))
    return { format: "unsupported", reason: "a ZIP archive inside the input; extract it first" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { format: "unsupported", reason: "not UTF-8 text" };
  }
  let parsed: { value: unknown; unsafeIntegers: boolean } | undefined;
  try {
    parsed = parseJsonText(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    // OTLP/JSON exports are also written one request a line.
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return { format: "unsupported", reason: "not JSON" };
    const envelopes: Record<string, unknown>[] = [];
    for (const line of lines) {
      let value: unknown;
      try {
        value = parseJsonText(line).value;
      } catch {
        return { format: "unsupported", reason: "not JSON" };
      }
      if (!isOtlpEnvelope(value))
        return { format: "unsupported", reason: "JSON Lines whose records are not OTLP exports" };
      envelopes.push(value as Record<string, unknown>);
    }
    return { format: "otlp_json", envelopes };
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    if (value.length && value.every(isOtlpEnvelope))
      return { format: "otlp_json", envelopes: value as Record<string, unknown>[] };
    return { format: "unsupported", reason: "a JSON array that is not a list of OTLP exports" };
  }
  if (!isObject(value)) return { format: "unsupported", reason: "not a JSON object" };
  if (isOtlpEnvelope(value)) return { format: "otlp_json", envelopes: [value] };
  if (Array.isArray(value.resourceLogs) || Array.isArray(value.resource_logs))
    return { format: "unsupported", reason: "an OTLP logs export; only traces are imported" };
  if (typeof value.schema_version === "string" && value.schema_version.startsWith("ATIF-")) {
    if (!Array.isArray(value.steps))
      return { format: "unsupported", reason: "an ATIF document without steps" };
    return { format: "atif", text, document: value, unsafeIntegers: parsed.unsafeIntegers };
  }
  const key = Array.isArray(value.data)
    ? "data"
    : Array.isArray(value.observations)
      ? "observations"
      : undefined;
  if (key) {
    if (value.data !== undefined && value.observations !== undefined)
      return { format: "unsupported", reason: "two observation envelopes in one file" };
    const records = value[key] as unknown[];
    if (!records.length)
      return { format: "unsupported", reason: "a Langfuse export without observations" };
    if (!records.every(isObservation))
      return { format: "unsupported", reason: "a `data` list that is not Langfuse observations" };
    const envelope = Object.fromEntries(
      Object.entries(value).filter(([name]) => name !== key),
    ) as Record<string, JsonValue>;
    return {
      format: "langfuse_observations",
      observations: records,
      envelope,
      unsafeIntegers: parsed.unsafeIntegers,
    };
  }
  return { format: "unsupported", reason: "a JSON document of no recognized shape" };
}

// --- Attributes and large values ----------------------------------------------------------------

export function anyValue(value: JsonValue): OtlpValue {
  if (value === null) return {};
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number")
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  return {
    kvlistValue: {
      values: Object.entries(value).map(([key, item]) => ({ key, value: anyValue(item) })),
    },
  };
}

/** The large values one trace stores apart from its spans, each once by digest. */
export class BlobSink {
  readonly blobs = new Map<string, PreparedBlob>();

  /** Stores a text whole and returns what its record keeps: the first 16 KiB and the `hue.blobs`
   * entry; undefined when the text is over the limit of one stored value. */
  place(key: string, text: string): { prefix: string; entry: string } | undefined {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength > traceImportLimits.blobBytes) return undefined;
    const sha256 = sha256Hex(bytes);
    const contentType = textContentType(text);
    if (!this.blobs.has(sha256))
      this.blobs.set(sha256, { sha256, byteSize: bytes.byteLength, contentType, bytes });
    return {
      prefix: blobPrefix(text),
      entry: blobEntry(key, sha256, bytes.byteLength, contentType),
    };
  }

  /** The values in digest order: the manifest lists a trace's values the same whatever order its
   * sources were read in, so renaming or repacking them keeps the manifest digest. */
  sorted(): PreparedBlob[] {
    return [...this.blobs.values()].sort((a, b) =>
      a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0,
    );
  }
}

/** A converted span's attributes: a value over the inline limit is stored apart from the span
 * through the trace's {@link BlobSink} and listed in `hue.blobs`, as the SDK's exporter lists
 * the values it uploads, with the key in `hue.truncated`. */
export class AttributeList {
  readonly values: OtlpAttribute[] = [];
  private readonly listed: string[] = [];
  private readonly truncated: string[] = [];

  constructor(private readonly blobs: BlobSink) {}

  add(key: string, value: JsonValue): void {
    const text = typeof value === "string" ? value : undefined;
    const bytes =
      text !== undefined
        ? Buffer.byteLength(text, "utf8")
        : Buffer.byteLength(JSON.stringify(value));
    if (bytes <= MAX_INLINE_VALUE_BYTES || this.listed.length >= MAX_BLOB_ENTRIES) {
      this.values.push({ key, value: anyValue(value) });
      return;
    }
    const placed = this.blobs.place(key, text ?? JSON.stringify(value));
    if (!placed) throw new ConversionError("A source value exceeds the stored value limit");
    this.values.push({ key, value: { stringValue: placed.prefix } });
    this.listed.push(placed.entry);
    this.truncated.push(key);
  }

  json(key: string, value: unknown): void {
    this.add(key, JSON.stringify(value));
  }

  finish(): OtlpAttribute[] {
    if (this.listed.length) {
      this.values.push({ key: BLOBS_KEY, value: anyValue(this.listed) });
      this.values.push({ key: TRUNCATED_KEY, value: anyValue(this.truncated) });
    }
    return this.values;
  }
}

// --- OTLP/JSON --------------------------------------------------------------------------------

/** ProtoJSON parsers accept the proto field names beside lowerCamelCase: a body whose envelope
 * uses them is read with every field renamed in place; attribute keys are values, never renamed. */
function renameProtoFields(decoded: unknown): void {
  const stack: unknown[] = [decoded];
  while (stack.length) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      for (const entry of item) stack.push(entry);
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      stack.push(value);
      if (!key.includes("_")) continue;
      const renamed = key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
      if (renamed === key) continue;
      if (!Object.hasOwn(record, renamed)) record[renamed] = value;
      delete record[key];
    }
  }
}

/** An OTLP id as sent (hex, or the base64 of a protobuf-JSON encoder) as lowercase hex, or
 * undefined for anything that is not a valid nonzero id of the length. */
function normalizeId(value: unknown, length: 32 | 16): string | undefined {
  if (typeof value !== "string") return undefined;
  const base64 = length === 32 ? BASE64_TRACE_ID : BASE64_SPAN_ID;
  const candidate = base64.test(value)
    ? Buffer.from(value, "base64").toString("hex")
    : value.toLowerCase();
  return (length === 32 ? HEX32 : HEX16).test(candidate) && !/^0+$/.test(candidate)
    ? candidate
    : undefined;
}

function decimalOf(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return String(BigInt(value));
  return undefined;
}

const stringOf = (value: OtlpValue | undefined) =>
  value && typeof value.stringValue === "string" ? value.stringValue : undefined;

function attributeMap(attributes: readonly OtlpAttribute[]): Map<string, OtlpValue> {
  const map = new Map<string, OtlpValue>();
  for (const attribute of attributes) map.set(attribute.key, attribute.value);
  return map;
}

/** A trace's identity as its root records it, in the attributes Hue reads. */
function identityOf(
  root: ReadonlyMap<string, OtlpValue>,
  resource: ReadonlyMap<string, OtlpValue>,
): TraceIdentity | undefined {
  const identity: TraceIdentity = {};
  for (const key of USER_KEYS) {
    const user = identifier(stringOf(root.get(key)), MAX_IDENTIFIER);
    if (user) {
      identity.user = user;
      break;
    }
  }
  for (const source of [root, resource]) {
    const namespace = identifier(stringOf(source.get(ENTITY_NAMESPACE)), MAX_NAMESPACE);
    const id = identifier(stringOf(source.get(ENTITY_ID)), MAX_IDENTIFIER);
    if (namespace && id) {
      identity.entity = { namespace, id };
      break;
    }
  }
  for (const key of SESSION_KEYS) {
    const session = identifier(stringOf(root.get(key)), MAX_SESSION);
    if (session) {
      identity.session = session;
      break;
    }
  }
  return identity.user || identity.entity || identity.session ? identity : undefined;
}

interface OtlpSpanDraft {
  spanId: string;
  parentSpanId?: string;
  start: bigint;
  entry: ImportEntry;
  canonical: string;
  attributes: Map<string, OtlpValue>;
  resource: Map<string, OtlpValue>;
}

interface OtlpTraceDraft {
  traceId: string;
  remappedTraceId: boolean;
  spans: Map<string, OtlpSpanDraft>;
  blobs: BlobSink;
  sourceDigests: Set<string>;
  remappedSpans: number;
  evaluation: boolean;
  simulation: boolean;
  production: boolean;
  conflict?: string;
}

/** Gathers the spans of OTLP/JSON exports by trace, across files: an export writes a trace's
 * spans in the requests that carried them, which need not be one file. */
export class OtlpTraceCollector {
  private readonly traces = new Map<string, OtlpTraceDraft>();

  /** Adds every span of the envelopes; the spans refused, with their reasons. */
  add(envelopes: readonly Record<string, unknown>[], sourceDigest: string): Refusal[] {
    const refused: Refusal[] = [];
    for (const envelope of envelopes) {
      // An export may mix the proto field names with lowerCamelCase at any depth; every
      // envelope is normalized whole, so a `scope_spans` under a `resourceSpans` root is read.
      renameProtoFields(envelope);
      const groups = Array.isArray(envelope.resourceSpans) ? envelope.resourceSpans : [];
      for (const groupValue of groups) {
        if (!isObject(groupValue)) continue;
        const { scopeSpans, ...resourceGroup } = groupValue;
        const resource = isObject(resourceGroup.resource)
          ? attributeMap(readAttributes(resourceGroup.resource.attributes) ?? [])
          : new Map<string, OtlpValue>();
        for (const scopeValue of Array.isArray(scopeSpans) ? scopeSpans : []) {
          if (!isObject(scopeValue)) continue;
          const { spans, ...scopeGroup } = scopeValue;
          const scopeName = isObject(scopeGroup.scope) ? scopeGroup.scope.name : undefined;
          for (const spanValue of Array.isArray(spans) ? spans : []) {
            try {
              this.addSpan(spanValue, resourceGroup, scopeGroup, resource, scopeName, sourceDigest);
            } catch (error) {
              if (!(error instanceof ConversionError)) throw error;
              refused.push({ reason: error.message });
            }
          }
        }
      }
    }
    return refused;
  }

  private addSpan(
    value: unknown,
    resourceGroup: Record<string, unknown>,
    scopeGroup: Record<string, unknown>,
    resource: Map<string, OtlpValue>,
    scopeName: unknown,
    sourceDigest: string,
  ): void {
    if (!isObject(value)) throw new ConversionError("a span that is not a JSON object");
    const span: Record<string, unknown> = { ...value };
    const originalTraceId = span.traceId;
    if (typeof originalTraceId !== "string" || !originalTraceId)
      throw new ConversionError("a span without a trace id");
    let traceId = normalizeId(originalTraceId, 32);
    const remappedTraceId = traceId === undefined;
    if (!traceId) traceId = digestHex(`otlp.trace:${originalTraceId}`, 32);
    const originalSpanId = span.spanId;
    if (typeof originalSpanId !== "string" || !originalSpanId)
      throw new ConversionError("a span without a span id");
    const mapSpanId = (original: string) =>
      normalizeId(original, 16) ?? digestHex(`otlp.span:${traceId}:${original}`, 16);
    const spanId = mapSpanId(originalSpanId);
    const remappedSpanId = normalizeId(originalSpanId, 16) === undefined;
    span.traceId = traceId;
    span.spanId = spanId;
    const parent = span.parentSpanId;
    let parentSpanId: string | undefined;
    if (typeof parent === "string" && parent && !/^[0=A]*$/.test(parent) && !/^0+$/.test(parent))
      parentSpanId = mapSpanId(parent);
    if (parentSpanId) span.parentSpanId = parentSpanId;
    else delete span.parentSpanId;
    const start = decimalOf(span.startTimeUnixNano);
    const end = decimalOf(span.endTimeUnixNano);
    if (start === undefined || start === "0")
      throw new ConversionError(`span ${spanId} has no valid start time`);
    if (end === undefined || BigInt(end) < BigInt(start))
      throw new ConversionError(`span ${spanId} has no valid end time`);
    span.startTimeUnixNano = start;
    span.endTimeUnixNano = end;
    if (span.name !== undefined && typeof span.name !== "string")
      throw new ConversionError(`span ${spanId} has a name that is not text`);
    const attributes = readAttributes(span.attributes);
    if (attributes === undefined)
      throw new ConversionError(`span ${spanId} has malformed attributes`);
    let trace = this.traces.get(traceId);
    if (!trace) {
      trace = {
        traceId,
        remappedTraceId,
        spans: new Map(),
        blobs: new BlobSink(),
        sourceDigests: new Set(),
        remappedSpans: 0,
        evaluation: false,
        simulation: false,
        production: false,
      };
      this.traces.set(traceId, trace);
    }
    const kept = [...attributes];
    if (remappedTraceId)
      kept.push({ key: "hue.import.original_trace_id", value: { stringValue: originalTraceId } });
    if (remappedSpanId)
      kept.push({ key: "hue.import.original_span_id", value: { stringValue: originalSpanId } });
    span.attributes = offloadOtlpValues(kept, trace.blobs);
    const entry: ImportEntry = {
      ...resourceGroup,
      scopeSpans: [{ ...scopeGroup, spans: [span] }],
    };
    const canonical = JSON.stringify(entry);
    const held = trace.spans.get(spanId);
    if (held) {
      // The same span sent twice is one span; another payload under its id is a conflict.
      if (held.canonical !== canonical)
        trace.conflict ??= `span ${spanId} appears with different content`;
      trace.sourceDigests.add(sourceDigest);
      return;
    }
    const map = attributeMap(kept);
    for (const key of EVALUATION_KEYS)
      if (map.has(key) || resource.has(key)) trace.evaluation = true;
    for (const key of SIMULATION_KEYS)
      if (map.has(key) || resource.has(key)) trace.simulation = true;
    if (scopeName === SIMULATION_SCOPE) trace.simulation = true;
    if (
      stringOf(resource.get("deployment.environment.name")) === "production" ||
      stringOf(resource.get("deployment.environment")) === "production"
    )
      trace.production = true;
    if (remappedSpanId) trace.remappedSpans++;
    trace.sourceDigests.add(sourceDigest);
    trace.spans.set(spanId, {
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      start: BigInt(start),
      entry,
      canonical,
      attributes: map,
      resource,
    });
  }

  /** Every trace gathered so far, spans in time order, and the traces refused whole. */
  finish(): { traces: ConvertedTrace[]; refused: Refusal[] } {
    const traces: ConvertedTrace[] = [];
    const refused: Refusal[] = [];
    for (const draft of this.traces.values()) {
      if (draft.conflict) {
        refused.push({ traceId: draft.traceId, reason: draft.conflict });
        continue;
      }
      const spans = [...draft.spans.values()].sort((a, b) =>
        a.start < b.start ? -1 : a.start > b.start ? 1 : a.spanId < b.spanId ? -1 : 1,
      );
      const root = spans.find((span) => !span.parentSpanId || !draft.spans.has(span.parentSpanId));
      const identity = root ? identityOf(root.attributes, root.resource) : undefined;
      traces.push({
        traceId: draft.traceId,
        format: "otlp_json",
        entries: spans.map((span) => span.entry),
        blobs: draft.blobs.sorted(),
        ...(identity ? { identity } : {}),
        origin: draft.evaluation
          ? "evaluation"
          : draft.simulation
            ? "simulation"
            : draft.production
              ? "production"
              : "unknown",
        sourceDigests: draft.sourceDigests,
        remappedTraceId: draft.remappedTraceId,
        remappedSpans: draft.remappedSpans,
      });
    }
    return { traces, refused };
  }
}

/** An OTLP attribute list as recorded, or undefined when it is malformed. */
function readAttributes(value: unknown): OtlpAttribute[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const attributes: OtlpAttribute[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.key !== "string" || !isObject(item.value)) return undefined;
    attributes.push(item as unknown as OtlpAttribute);
  }
  return attributes;
}

/** A recorded span's string values over the inline limit stored apart from it, listed beside
 * any values its exporter already listed. */
function offloadOtlpValues(attributes: OtlpAttribute[], blobs: BlobSink): OtlpAttribute[] {
  const over = attributes.filter(
    (attribute) =>
      typeof attribute.value.stringValue === "string" &&
      Buffer.byteLength(attribute.value.stringValue, "utf8") > MAX_INLINE_VALUE_BYTES,
  );
  if (!over.length) return attributes;
  const listedValues = (key: string): string[] | undefined => {
    const found = attributes.find((attribute) => attribute.key === key);
    if (!found) return [];
    const values = found.value.arrayValue?.values;
    if (!values || values.some((value) => typeof value.stringValue !== "string")) return undefined;
    return values.map((value) => value.stringValue!);
  };
  const listed = listedValues(BLOBS_KEY);
  const truncated = listedValues(TRUNCATED_KEY);
  if (listed === undefined || truncated === undefined) return attributes;
  const result = attributes.filter(
    (attribute) => attribute.key !== BLOBS_KEY && attribute.key !== TRUNCATED_KEY,
  );
  for (const attribute of over) {
    if (listed.length >= MAX_BLOB_ENTRIES) break;
    const placed = blobs.place(attribute.key, attribute.value.stringValue!);
    if (!placed) continue;
    const at = result.indexOf(attribute);
    result[at] = { key: attribute.key, value: { stringValue: placed.prefix } };
    listed.push(placed.entry);
    if (!truncated.includes(attribute.key)) truncated.push(attribute.key);
  }
  if (listed.length) {
    result.push({ key: BLOBS_KEY, value: anyValue(listed) });
    result.push({ key: TRUNCATED_KEY, value: anyValue(truncated) });
  }
  return result;
}

// --- Langfuse observations --------------------------------------------------------------------

function text(value: JsonValue | undefined, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new ConversionError("A required source text field is absent");
    return "";
  }
  if (typeof value !== "string") throw new ConversionError("Expected a source text field");
  if (required && !value) throw new ConversionError("A required source text field is empty");
  return value;
}

function integer(value: JsonValue | undefined): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ConversionError("Expected a nonnegative source token count");
  return value;
}

export function unixNano(value: JsonValue | undefined): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    text(value, true),
  );
  if (!match) throw new ConversionError("Invalid source timestamp");
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isSafeInteger(seconds) || seconds < 0)
    throw new ConversionError("Invalid source timestamp");
  return (BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"))).toString();
}

const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** Validates parent links without rewalking ancestry already settled by another child. */
function ancestryIssue(
  parents: ReadonlyMap<string, string | undefined>,
): "missing_parent" | "cyclic_ancestry" | undefined {
  const settled = new Set<string>();
  for (const id of parents.keys()) {
    const path: string[] = [];
    const active = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !settled.has(current)) {
      if (active.has(current)) return "cyclic_ancestry";
      if (!parents.has(current)) return "missing_parent";
      active.add(current);
      path.push(current);
      current = parents.get(current) || undefined;
    }
    for (const ancestor of path) settled.add(ancestor);
  }
  return undefined;
}

interface LangfuseTraceDraft {
  originalTraceId: string;
  observations: Map<string, { record: Record<string, JsonValue>; canonical: string }>;
  envelopes: Map<string, string>;
  sourceDigests: Set<string>;
  conflict?: string;
}

/** Gathers Langfuse observations by trace across files and converts each trace as Hue's reader
 * converts an observation export: one span per observation, the record kept whole. */
export class LangfuseTraceCollector {
  private readonly traces = new Map<string, LangfuseTraceDraft>();

  add(
    observations: readonly Record<string, JsonValue>[],
    envelope: Record<string, JsonValue>,
    sourceDigest: string,
  ): void {
    const envelopeText = JSON.stringify(envelope);
    for (const observation of observations) {
      const traceId = text(observation.traceId, true);
      const id = text(observation.id, true);
      let draft = this.traces.get(traceId);
      if (!draft) {
        draft = {
          originalTraceId: traceId,
          observations: new Map(),
          envelopes: new Map(),
          sourceDigests: new Set(),
        };
        this.traces.set(traceId, draft);
      }
      draft.sourceDigests.add(sourceDigest);
      draft.envelopes.set(sourceDigest, envelopeText);
      const canonical = canonicalJson(observation);
      const held = draft.observations.get(id);
      if (held) {
        if (held.canonical !== canonical)
          draft.conflict ??= `observation ${id} appears with different content`;
        continue;
      }
      draft.observations.set(id, { record: observation, canonical });
    }
  }

  finish(): { traces: ConvertedTrace[]; refused: Refusal[] } {
    const traces: ConvertedTrace[] = [];
    const refused: Refusal[] = [];
    for (const draft of this.traces.values()) {
      const traceId = hueTraceId(draft.originalTraceId);
      if (draft.conflict) {
        refused.push({ traceId, reason: draft.conflict });
        continue;
      }
      try {
        traces.push(convertLangfuseTrace(draft, traceId));
      } catch (error) {
        if (!(error instanceof ConversionError)) throw error;
        refused.push({ traceId, reason: error.message });
      }
    }
    return { traces, refused };
  }
}

function convertLangfuseTrace(draft: LangfuseTraceDraft, traceId: string): ConvertedTrace {
  const originalTraceId = draft.originalTraceId;
  for (const { record } of draft.observations.values()) validateSource(record);
  // Observations in time order, then by id: the same trace from any packing orders the same.
  const observations = [...draft.observations.values()]
    .map(({ record }) => ({ record, start: BigInt(unixNano(record.startTime)) }))
    .sort((a, b) =>
      a.start < b.start
        ? -1
        : a.start > b.start
          ? 1
          : text(a.record.id, true) < text(b.record.id, true)
            ? -1
            : 1,
    )
    .map(({ record }) => record);
  const ids = new Set<string>();
  let roots = 0;
  for (const observation of observations) {
    ids.add(text(observation.id, true));
    if (!text(observation.parentObservationId)) roots++;
  }
  if (roots !== 1) throw new ConversionError("Expected one root observation per source trace");
  const parents = new Map<string, string>();
  for (const observation of observations) {
    const parent = text(observation.parentObservationId);
    if (parent && !ids.has(parent)) throw new ConversionError("A source parent is missing");
    parents.set(text(observation.id, true), parent);
  }
  const ancestry = ancestryIssue(parents);
  if (ancestry === "missing_parent") throw new ConversionError("A source parent is missing");
  if (ancestry === "cyclic_ancestry")
    throw new ConversionError("The source hierarchy contains a cycle");
  // The export's envelope is kept on the root when one file held the whole trace.
  const envelope = draft.envelopes.size === 1 ? [...draft.envelopes.values()][0]! : undefined;
  const blobs = new BlobSink();
  const spanIds = new Map<string, string>();
  const imported = new Set<string>();
  let remappedSpans = 0;
  for (const [index, observation] of observations.entries()) {
    const originalId = text(observation.id, true);
    let spanId = hueSpanId(originalTraceId, originalId);
    if (spanId !== originalId) remappedSpans++;
    if (imported.has(spanId)) {
      let salt = 0;
      do spanId = digestHex(`langfuse.observation.duplicate:${traceId}:${index}:${salt++}`, 16);
      while (ids.has(spanId) || imported.has(spanId) || /^0+$/.test(spanId));
      remappedSpans++;
    }
    imported.add(spanId);
    spanIds.set(originalId, spanId);
  }
  let identity: TraceIdentity | undefined;
  // The origin markers the OTLP reader applies, read from the converted attributes with the same
  // precedence: an evaluation's or a simulated world's records are never production history,
  // whatever environment the export was taken from.
  let production = false;
  let evaluation = false;
  let simulation = false;
  const markOrigin = (key: string, value: JsonValue, resourceAttribute: boolean) => {
    if (EVALUATION_KEYS.includes(key)) evaluation = true;
    if (SIMULATION_KEYS.includes(key)) simulation = true;
    if (
      resourceAttribute &&
      (key === "deployment.environment.name" || key === "deployment.environment") &&
      value === "production"
    )
      production = true;
  };
  const entries = observations.map((observation, index): ImportEntry => {
    const originalId = text(observation.id, true);
    const spanId = spanIds.get(originalId)!;
    const startTimeUnixNano = unixNano(observation.startTime);
    // An observation without an end (a Langfuse event) lasts no time, as `hue import langfuse`
    // sends it.
    const ended = observation.endTime !== undefined && observation.endTime !== null;
    const endTimeUnixNano = ended ? unixNano(observation.endTime) : startTimeUnixNano;
    if (BigInt(endTimeUnixNano) < BigInt(startTimeUnixNano))
      throw new ConversionError("A source observation has negative duration");
    const type = text(observation.type, true).toLowerCase();
    const metadata = object(observation.metadata ?? {});
    const attributes = new AttributeList(blobs);
    const resource: OtlpAttribute[] = [];
    for (const [key, value] of Object.entries(metadata)) {
      if (key.startsWith("hue.import."))
        throw new ConversionError("Source metadata uses reserved import keys");
      if (key.startsWith("resourceAttributes.")) {
        const resourceKey = key.slice("resourceAttributes.".length);
        resource.push({ key: resourceKey, value: anyValue(value) });
        markOrigin(resourceKey, value, true);
      } else if (key !== "scope.name" && key !== "scope.version") {
        attributes.add(key, value);
        markOrigin(key, value, false);
      }
    }
    if (text(metadata["scope.name"]) === SIMULATION_SCOPE) simulation = true;
    attributes.add("hue.import.source_index", index);
    attributes.add("hue.import.original_span_id", originalId);
    if (traceId !== originalTraceId)
      attributes.add("hue.import.original_trace_id", originalTraceId);
    attributes.add(SOURCE_RECORD, JSON.stringify(observation));
    const parent = text(observation.parentObservationId);
    if (!parent && envelope !== undefined) attributes.add(SOURCE_ENVELOPE, envelope);
    attributes.add("langfuse.observation.type", type);
    for (const field of ["input", "output"] as const) {
      const value = observation[field];
      if (value === undefined || value === null || value === "") continue;
      attributes.add(`langfuse.observation.${field}`, value);
    }
    for (const [field, key] of [
      ["model", "langfuse.observation.model.name"],
      ["sessionId", "langfuse.session.id"],
      ["userId", "langfuse.user.id"],
      ["traceName", "langfuse.trace.name"],
      ["release", "langfuse.release"],
      ["environment", "langfuse.environment"],
      ["level", "langfuse.observation.level"],
    ] as const) {
      const value = observation[field];
      if (value !== undefined && value !== null && value !== "") attributes.add(key, value);
    }
    if (observation.usageDetails !== undefined)
      attributes.add(
        "langfuse.observation.usage_details",
        JSON.stringify(observation.usageDetails),
      );
    if (type === "generation") {
      if (observation.inputUsage !== undefined && observation.inputUsage !== null)
        attributes.add("gen_ai.usage.input_tokens", integer(observation.inputUsage));
      if (observation.outputUsage !== undefined && observation.outputUsage !== null)
        attributes.add("gen_ai.usage.output_tokens", integer(observation.outputUsage));
      const usage = object(observation.usageDetails ?? {});
      for (const [field, key] of [
        ["input_cached_tokens", "gen_ai.usage.cache_read.input_tokens"],
        ["input_cache_write_tokens", "gen_ai.usage.cache_write.input_tokens"],
      ] as const)
        if (usage[field] !== undefined && usage[field] !== null)
          attributes.add(key, integer(usage[field]));
    }
    attributes.add("hue.import.status_source", "langfuse.level");
    if (observation.environment === "production") production = true;
    const message = text(observation.statusMessage);
    const span: ImportSpan = {
      traceId,
      spanId,
      ...(parent ? { parentSpanId: spanIds.get(parent)! } : {}),
      name: text(observation.name, true),
      // The export does not retain the original OTLP span kind.
      kind: 0,
      startTimeUnixNano,
      endTimeUnixNano,
      attributes: attributes.finish(),
      status: { code: observation.level === "ERROR" ? 2 : 0, ...(message ? { message } : {}) },
    };
    // The trace's owner as the OTLP reader takes it from a root: the user (`langfuse.user.id`
    // among the keys), an explicit entity in the root's metadata or resource attributes, and the
    // session.
    if (!parent) identity = identityOf(attributeMap(span.attributes), attributeMap(resource));
    return {
      resource: { attributes: resource },
      scopeSpans: [
        {
          scope: {
            ...(text(metadata["scope.name"]) ? { name: text(metadata["scope.name"]) } : {}),
            ...(text(metadata["scope.version"])
              ? { version: text(metadata["scope.version"]) }
              : {}),
          },
          spans: [span],
        },
      ],
    };
  });
  return {
    traceId,
    format: "langfuse_observations",
    entries,
    blobs: blobs.sorted(),
    ...(identity ? { identity } : {}),
    origin: evaluation
      ? "evaluation"
      : simulation
        ? "simulation"
        : production
          ? "production"
          : "unknown",
    sourceDigests: draft.sourceDigests,
    remappedTraceId: traceId !== originalTraceId,
    remappedSpans,
  };
}

// --- ATIF -------------------------------------------------------------------------------------

/** The ATIF reader's bounds: a text export of at most 4 MiB and 2,000 spans. */
export const MAX_ATIF_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ATIF_SPANS = 2000;
/** The conversion's generation, part of every derived trace and span id: raised when the ids'
 * seed or the spans' shape changes, so a bundle prepared by an earlier generation is prepared
 * again rather than mixed with this one. 3 names the format generically; 2 carried one
 * producer's name in the label, the scope and the seed. */
const ATIF_IMPORT_VERSION = "3";
/** The format label (`hue.import.format`) and instrumentation scope of a trace converted from
 * ATIF, the Agent Trajectory Interchange Format: the format's own name, whoever exported it. */
const ATIF_FORMAT = "atif";
const ATIF_SCOPE = "hue.import.atif";

/** The agent span's name, from the export's own agent: `invoke_agent <agent.name>`, or
 * `invoke_agent` alone when the export names none. */
function agentSpanName(t: { agent: { name?: unknown } }): string {
  const name = typeof t.agent.name === "string" ? t.agent.name.trim() : "";
  return name ? `invoke_agent ${name}` : "invoke_agent";
}

const optionalText = z.string().nullable().optional();
const identity = z.string().min(1).max(512);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional();
const extra = z.record(z.string(), z.json()).nullable().optional();
const metrics = z.strictObject({
  prompt_tokens: count,
  completion_tokens: count,
  cached_tokens: count,
  cost_usd: z.number().nonnegative().nullable().optional(),
  prompt_token_ids: z.array(z.number().int().nonnegative()).nullable().optional(),
  completion_token_ids: z.array(z.number().int().nonnegative()).nullable().optional(),
  logprobs: z.array(z.number()).nullable().optional(),
  extra,
});
const call = z.strictObject({
  tool_call_id: identity,
  function_name: identity,
  arguments: z.record(z.string(), z.json()),
  extra,
});
/** A delegated subagent's trajectory (ATIF v1.7+). Only the embedded form resolves:
 * `trajectory_id` names an entry of the root's `subagent_trajectories`. */
const subagentRef = z.strictObject({
  trajectory_id: identity.nullable().optional(),
  trajectory_path: optionalText,
  session_id: identity.nullable().optional(),
  extra,
});
const result = z.strictObject({
  source_call_id: identity,
  content: z.string(),
  subagent_trajectory_ref: z.array(subagentRef).min(1).nullable().optional(),
  extra,
});
const step = z.strictObject({
  step_id: z.number().int().positive(),
  timestamp: z.string(),
  source: z.enum(["system", "user", "agent"]),
  message: z.string(),
  model_name: optionalText,
  reasoning_effort: z.union([z.string(), z.number()]).nullable().optional(),
  reasoning_content: optionalText,
  tool_calls: z.array(call).nullable().optional(),
  observation: z
    .strictObject({ results: z.array(result) })
    .nullable()
    .optional(),
  metrics: metrics.nullable().optional(),
  llm_call_count: count,
  is_copied_context: z.boolean().nullable().optional(),
  extra,
});
// v1.8 adds only audio content parts, which the text-only `message` and `content` fields refuse.
const trajectoryFields = {
  schema_version: z.enum(["ATIF-v1.7", "ATIF-v1.8"]),
  trajectory_id: identity.nullable().optional(),
  agent: z.strictObject({
    name: identity,
    version: identity,
    model_name: optionalText,
    tool_definitions: z.array(z.json()).nullable().optional(),
    extra,
  }),
  steps: z.array(step).min(1).max(MAX_ATIF_SPANS),
  notes: optionalText,
  final_metrics: z
    .strictObject({
      total_prompt_tokens: count,
      total_completion_tokens: count,
      total_cached_tokens: count,
      total_cost_usd: z.number().nonnegative().nullable().optional(),
      total_steps: count,
      extra,
    })
    .nullable()
    .optional(),
  extra,
};
const subagentTrajectory = z.strictObject({
  ...trajectoryFields,
  session_id: identity.nullable().optional(),
  trajectory_id: identity,
  subagent_trajectories: z.array(z.json()).nullable().optional(),
});
const trajectory = z.strictObject({
  ...trajectoryFields,
  session_id: identity,
  subagent_trajectories: z.array(subagentTrajectory).max(MAX_ATIF_SPANS).nullable().optional(),
});
type AtifStep = z.infer<typeof step>;
type SubagentTrajectory = z.infer<typeof subagentTrajectory>;
type AtifTrajectory = z.infer<typeof trajectory> | SubagentTrajectory;
type Message = {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
};

/** Retains nanoseconds and requires an explicit timezone, valid calendar date and OTLP uint64. */
export function atifUnixNano(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) throw new ConversionError("ATIF timestamps require an ISO date and timezone");
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate() ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59 ||
    Number(match[9] ?? 0) > 23 ||
    Number(match[10] ?? 0) > 59
  )
    throw new ConversionError("ATIF contains an invalid calendar timestamp");
  const milliseconds = Date.parse(`${value.slice(0, 19)}${match[8]}`);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new ConversionError("ATIF timestamp is outside the supported range");
  const nanos = BigInt(milliseconds) * 1_000_000n + BigInt((match[7] ?? "").padEnd(9, "0"));
  if (nanos <= 0n || nanos > 18_446_744_073_709_551_615n)
    throw new ConversionError("ATIF timestamp is outside the supported range");
  return nanos.toString();
}

function addUsage(attributes: AttributeList, values: z.infer<typeof metrics> | null | undefined) {
  for (const [field, key] of [
    ["prompt_tokens", "gen_ai.usage.input_tokens"],
    ["completion_tokens", "gen_ai.usage.output_tokens"],
    ["cached_tokens", "gen_ai.usage.cache_read.input_tokens"],
  ] as const) {
    const value = values?.[field];
    if (value !== undefined && value !== null) attributes.add(key, value);
  }
  if (values?.cost_usd !== undefined && values.cost_usd !== null)
    attributes.json("hue.import.source_cost_usd", values.cost_usd);
}

function assertStep(loaded: AtifStep, index: number, allCalls: Set<string>) {
  if (loaded.step_id !== index + 1)
    throw new ConversionError("ATIF step IDs must be consecutive and ordered from 1");
  if (loaded.is_copied_context === true)
    throw new ConversionError("Copied context requires a continuation-aware importer");
  if (loaded.source !== "agent") {
    if (
      loaded.model_name != null ||
      loaded.reasoning_effort != null ||
      loaded.reasoning_content != null ||
      loaded.tool_calls != null ||
      loaded.metrics != null ||
      (loaded.llm_call_count != null && loaded.llm_call_count !== 0) ||
      loaded.observation?.results.length
    )
      throw new ConversionError("Non-agent ATIF steps may only contain recorded input messages");
    return;
  }
  if (loaded.llm_call_count !== 1)
    throw new ConversionError("ATIF agent steps must represent one model call");
  const calls = loaded.tool_calls ?? [];
  const results = loaded.observation?.results ?? [];
  const stepCalls = new Set<string>();
  for (const requested of calls) {
    if (allCalls.has(requested.tool_call_id))
      throw new ConversionError("ATIF contains a duplicate tool call ID");
    allCalls.add(requested.tool_call_id);
    stepCalls.add(requested.tool_call_id);
  }
  const resultCalls = new Set<string>();
  for (const observed of results) {
    if (!stepCalls.has(observed.source_call_id))
      throw new ConversionError("ATIF observation does not match a tool in its step");
    if (resultCalls.has(observed.source_call_id))
      throw new ConversionError("ATIF has duplicate observations for one tool call");
    resultCalls.add(observed.source_call_id);
  }
  if (stepCalls.size !== resultCalls.size)
    throw new ConversionError("ATIF is missing a tool call observation");
  const usage = loaded.metrics;
  if (
    usage?.cached_tokens != null &&
    usage.prompt_tokens != null &&
    usage.cached_tokens > usage.prompt_tokens
  )
    throw new ConversionError("ATIF cached tokens exceed total input tokens");
}

const laterNanos = (a: string, b: string) => (BigInt(b) > BigInt(a) ? b : a);
const earlierNanos = (a: string, b: string) => (BigInt(b) < BigInt(a) ? b : a);

interface AtifUsage {
  recordedInputTokens: number;
  recordedOutputTokens: number;
  recordedCachedTokens: number;
  stepsWithInputTokens: number;
  stepsWithOutputTokens: number;
  stepsWithCachedTokens: number;
}
interface CheckedTrajectory {
  times: string[];
  /** The earliest recorded instant: the first input message's, however they are stamped. */
  start: string;
  modelSteps: AtifStep[];
  usage: AtifUsage;
}

/** One trajectory's steps, instants and recorded usage, checked as a complete standalone export:
 * the root and each embedded subagent alike. Tool call IDs are unique across the whole export. */
function checkTrajectory(source: AtifTrajectory, allCalls: Set<string>): CheckedTrajectory {
  const modelSteps = source.steps.filter((loaded) => loaded.source === "agent");
  if (!modelSteps.length) throw new ConversionError("ATIF contains no agent steps");
  const firstAgentIndex = source.steps.findIndex((loaded) => loaded.source === "agent");
  if (source.steps.some((loaded, index) => index > firstAgentIndex && loaded.source !== "agent"))
    throw new ConversionError(
      "Unsupported ATIF multi-turn export; input messages must precede all agent steps",
    );
  const times = source.steps.map((loaded, index) => {
    assertStep(loaded, index, allCalls);
    return atifUnixNano(loaded.timestamp);
  });
  // The input messages before the first agent step are the task as given, not timed actions;
  // every agent step follows all of them and the agent step before it.
  let latest = times[0]!;
  for (let index = 1; index < times.length; index++) {
    if (index < firstAgentIndex) {
      latest = laterNanos(latest, times[index]!);
      continue;
    }
    if (BigInt(times[index]!) < BigInt(latest))
      throw new ConversionError("ATIF step timestamps must follow recorded step order");
    latest = times[index]!;
  }
  const start = times.slice(0, firstAgentIndex + 1).reduce(earlierNanos);
  if (
    source.final_metrics?.total_steps != null &&
    source.final_metrics.total_steps !== source.steps.length
  )
    throw new ConversionError("ATIF final step count does not match the complete export");
  const usage: AtifUsage = {
    recordedInputTokens: 0,
    recordedOutputTokens: 0,
    recordedCachedTokens: 0,
    stepsWithInputTokens: 0,
    stepsWithOutputTokens: 0,
    stepsWithCachedTokens: 0,
  };
  const finalInput = source.final_metrics?.total_prompt_tokens;
  const finalCached = source.final_metrics?.total_cached_tokens;
  if (finalInput != null && finalCached != null && finalCached > finalInput)
    throw new ConversionError("ATIF final cached tokens exceed total input tokens");
  for (const [field, total, tally, presence] of [
    ["prompt_tokens", "total_prompt_tokens", "recordedInputTokens", "stepsWithInputTokens"],
    [
      "completion_tokens",
      "total_completion_tokens",
      "recordedOutputTokens",
      "stepsWithOutputTokens",
    ],
    ["cached_tokens", "total_cached_tokens", "recordedCachedTokens", "stepsWithCachedTokens"],
  ] as const) {
    for (const loaded of modelSteps) {
      const value = loaded.metrics?.[field];
      if (value != null) {
        usage[tally] += value;
        usage[presence]++;
      }
    }
    if (!Number.isSafeInteger(usage[tally]))
      throw new ConversionError("ATIF aggregate usage exceeds the exact integer bound");
    const recordedTotal = source.final_metrics?.[total];
    if (
      recordedTotal != null &&
      (recordedTotal < usage[tally] ||
        (usage[presence] === modelSteps.length && recordedTotal !== usage[tally]))
    )
      throw new ConversionError("ATIF final usage does not match its recorded model steps");
  }
  // Cached tokens establish a lower bound for a call whose total input is unavailable; they
  // never become invented per-call input usage or get added twice to known input.
  const minimumInput = modelSteps.reduce(
    (sum, loaded) => sum + (loaded.metrics?.prompt_tokens ?? loaded.metrics?.cached_tokens ?? 0),
    0,
  );
  if (!Number.isSafeInteger(minimumInput))
    throw new ConversionError("ATIF aggregate usage exceeds the exact integer bound");
  if (finalInput != null && finalInput < minimumInput)
    throw new ConversionError("ATIF final input tokens contradict recorded input/cache counts");
  const knownUncachedInput = modelSteps.reduce((sum, loaded) => {
    const input = loaded.metrics?.prompt_tokens;
    const cached = loaded.metrics?.cached_tokens;
    return sum + (input != null && cached != null ? input - cached : 0);
  }, 0);
  const totalInput =
    finalInput ??
    (usage.stepsWithInputTokens === modelSteps.length ? usage.recordedInputTokens : undefined);
  if (finalCached != null && totalInput != null && finalCached > totalInput - knownUncachedInput)
    throw new ConversionError("ATIF final cached tokens contradict recorded uncached input counts");
  return { times, start, modelSteps, usage };
}

/** A trajectory's own recorded totals, as its agent span reports them. */
function finalUsage(source: AtifTrajectory): z.infer<typeof metrics> | undefined {
  return source.final_metrics == null
    ? undefined
    : {
        prompt_tokens: source.final_metrics.total_prompt_tokens,
        completion_tokens: source.final_metrics.total_completion_tokens,
        cached_tokens: source.final_metrics.total_cached_tokens,
        cost_usd: source.final_metrics.total_cost_usd,
      };
}

/** An export's user id, where it is an identifier: one token, never an address or a name. */
function atifUserId(value: unknown): string | undefined {
  return typeof value === "string" && /^[^\s@]{1,200}$/.test(value) ? value : undefined;
}

/**
 * A text ATIF v1.7 or v1.8 export as one trace: an agent span for the run, a model span per
 * agent step with the conversation so far, a tool span per call under it, and an embedded
 * subagent trajectory as its own agent span under the tool span of the call that spawned it.
 * Identity is run scoped (`session_id` and `trajectory_id`), never a path. The complete original
 * document stays on the root; each model and tool span keeps its own record. ATIF supplies step
 * instants, not call durations: model and tool spans are zero-duration point spans.
 */
export function convertAtifExport(
  source: Extract<DetectedSource, { format: "atif" }>,
  rawBytes: number,
): ConvertedTrace {
  if (rawBytes > MAX_ATIF_FILE_BYTES)
    throw new ConversionError("ATIF file exceeds the import size bound");
  if (source.unsafeIntegers)
    throw new ConversionError("ATIF JSON has unsafe numbers, invalid text or excessive nesting");
  validateJsonText(source.text);
  try {
    validateSource(source.document as JsonValue);
  } catch {
    throw new ConversionError("ATIF JSON has unsafe numbers, invalid text or excessive nesting");
  }
  const validation = trajectory.safeParse(source.document);
  if (!validation.success)
    throw new ConversionError(
      "Unsupported or invalid ATIF v1.7/v1.8 shape; only standalone text exports are supported",
    );
  // Retain the original object after validation: a schema's cloned records may omit special
  // JSON keys such as __proto__, which are safe own properties on JSON.parse's objects.
  const document = source.document as z.infer<typeof trajectory>;
  const allCalls = new Set<string>();
  const main = checkTrajectory(document, allCalls);
  const embedded = new Map<
    string,
    { trajectory: SubagentTrajectory; checked: CheckedTrajectory; ref?: unknown }
  >();
  for (const sub of document.subagent_trajectories ?? []) {
    if (embedded.has(sub.trajectory_id))
      throw new ConversionError("ATIF embeds two subagent trajectories with one trajectory_id");
    if (
      sub.subagent_trajectories?.length ||
      sub.steps.some((loaded) =>
        (loaded.observation?.results ?? []).some(
          (returned) => returned.subagent_trajectory_ref != null,
        ),
      )
    )
      throw new ConversionError("ATIF subagents that spawn their own subagents are not supported");
    embedded.set(sub.trajectory_id, { trajectory: sub, checked: checkTrajectory(sub, allCalls) });
  }
  const spawned = new Map<string, SubagentTrajectory[]>();
  for (const [index, loaded] of document.steps.entries())
    for (const returned of loaded.observation?.results ?? [])
      for (const ref of returned.subagent_trajectory_ref ?? []) {
        if (ref.trajectory_id == null)
          throw new ConversionError(
            "ATIF references a subagent trajectory file; only embedded subagents are supported",
          );
        const found = embedded.get(ref.trajectory_id);
        if (!found)
          throw new ConversionError(
            "ATIF references a subagent trajectory the export does not embed",
          );
        if (found.ref !== undefined)
          throw new ConversionError("ATIF references one embedded subagent trajectory twice");
        if (BigInt(found.checked.start) < BigInt(main.times[index]!))
          throw new ConversionError("ATIF subagent starts before the step that spawned it");
        found.ref = ref;
        spawned.set(returned.source_call_id, [
          ...(spawned.get(returned.source_call_id) ?? []),
          found.trajectory,
        ]);
      }
  for (const found of embedded.values())
    if (found.ref === undefined)
      throw new ConversionError("ATIF embeds a subagent trajectory no observation references");
  const checked = [main, ...[...embedded.values()].map((found) => found.checked)];
  if (
    checked.reduce((sum, part) => sum + 1 + part.modelSteps.length, 0) + allCalls.size >
    MAX_ATIF_SPANS
  )
    throw new ConversionError("ATIF trace exceeds the import span bound");
  // Tied instants sort by `hue.import.source_index`: a step's place in execution order, where a
  // subagent's steps follow the step that spawned it.
  const order = new Map<AtifTrajectory, number[]>([[document, []]]);
  let ordinal = 0;
  for (const loaded of document.steps) {
    order.get(document)!.push(ordinal++);
    for (const requested of loaded.tool_calls ?? [])
      for (const sub of spawned.get(requested.tool_call_id) ?? [])
        order.set(
          sub,
          sub.steps.map(() => ordinal++),
        );
  }
  // The trace's identity is run scoped: the scope name, the conversion's generation, the
  // export's session and trajectory ids. Never a path, a file digest or a producer's name.
  const identityParts = [
    ATIF_SCOPE,
    ATIF_IMPORT_VERSION,
    document.session_id,
    document.trajectory_id ?? null,
  ];
  const traceId = sha256Hex(JSON.stringify(identityParts)).slice(0, 32);
  const spanId = (parts: (string | number)[]) =>
    sha256Hex(JSON.stringify([traceId, ...parts])).slice(0, 16);
  const rootId = spanId(["root"]);
  const blobs = new BlobSink();
  const entries: ImportEntry[] = [];
  // Roles are stated only where the export records delegation.
  const role = embedded.size ? "orchestrator" : undefined;
  const commonOf = (
    attributes: AttributeList,
    t: AtifTrajectory,
    agentRole?: "orchestrator" | "subagent",
  ) => {
    attributes.add("gen_ai.agent.name", t.agent.name);
    attributes.add("gen_ai.conversation.id", t.session_id ?? document.session_id);
    attributes.add("hue.import.format", ATIF_FORMAT);
    attributes.add("hue.import.source_schema", t.schema_version);
    if (agentRole) attributes.add("hue.agent.role", agentRole);
    if (agentRole === "subagent" && t.trajectory_id != null)
      attributes.add("hue.import.trajectory_id", t.trajectory_id);
  };
  const addSpan = (span: Omit<ImportSpan, "traceId" | "kind">) => {
    entries.push({
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: document.agent.name } },
          { key: "service.version", value: { stringValue: document.agent.version } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: ATIF_SCOPE, version: ATIF_IMPORT_VERSION },
          spans: [{ traceId, kind: 1, ...span }],
        },
      ],
    });
  };
  const inputOf = (t: AtifTrajectory) =>
    t.steps
      .filter((loaded) => loaded.source !== "agent")
      .map((loaded) => ({ role: loaded.source, content: loaded.message }));
  const replyOf = (t: AtifTrajectory) => [
    {
      role: "assistant",
      content: t.steps.filter((loaded) => loaded.source === "agent").at(-1)!.message,
    },
  ];
  const lastInstant = checked.map((part) => part.times.at(-1)!).reduce(laterNanos);
  // The root keeps the export as imported. Where it embeds subagents, each embedded trajectory is
  // kept whole on its own agent span instead, so the root keeps the rest of the export.
  const rootAttributes = new AttributeList(blobs);
  commonOf(rootAttributes, document, role);
  rootAttributes.add("gen_ai.operation.name", "invoke_agent");
  rootAttributes.json("gen_ai.input.messages", inputOf(document));
  rootAttributes.json("gen_ai.output.messages", replyOf(document));
  rootAttributes.add(
    SOURCE_RECORD,
    embedded.size
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(document).filter(([key]) => key !== "subagent_trajectories"),
          ),
        )
      : source.text,
  );
  if (embedded.size)
    rootAttributes.add("hue.import.source_record_scope", "export_without_embedded_subagents");
  rootAttributes.add(
    "hue.import.timing",
    "first_to_last_recorded_step; call_durations_unavailable",
  );
  addUsage(rootAttributes, finalUsage(document));
  addSpan({
    spanId: rootId,
    name: agentSpanName(document),
    startTimeUnixNano: main.start,
    endTimeUnixNano: lastInstant,
    attributes: rootAttributes.finish(),
    status: { code: 0 },
  });
  const addSteps = (
    t: AtifTrajectory,
    { times }: CheckedTrajectory,
    agentId: string,
    idParts: string[],
    agentRole: "orchestrator" | "subagent" | undefined,
  ) => {
    const sourceIndex = order.get(t)!;
    const history: Message[] = [];
    for (const [index, loaded] of t.steps.entries()) {
      if (loaded.source !== "agent") {
        history.push({ role: loaded.source, content: loaded.message });
        continue;
      }
      const modelId = spanId([...idParts, "step", loaded.step_id]);
      const calls = loaded.tool_calls ?? [];
      const observed = loaded.observation?.results ?? [];
      const output: Message = {
        role: "assistant",
        content: loaded.message,
        ...(calls.length
          ? {
              tool_calls: calls.map((requested) => ({
                id: requested.tool_call_id,
                type: "function",
                function: {
                  name: requested.function_name,
                  arguments: JSON.stringify(requested.arguments),
                },
              })),
            }
          : {}),
      };
      const modelAttributes = new AttributeList(blobs);
      commonOf(modelAttributes, t, agentRole);
      modelAttributes.add("gen_ai.operation.name", "chat");
      modelAttributes.json("gen_ai.input.messages", history);
      modelAttributes.add(
        "hue.import.input_source",
        "preceding_recorded_steps; runtime_prompt_unavailable",
      );
      modelAttributes.json("gen_ai.output.messages", [
        {
          ...output,
          ...(loaded.reasoning_content != null
            ? { reasoning_content: loaded.reasoning_content }
            : {}),
        },
      ]);
      modelAttributes.add("hue.import.source_index", sourceIndex[index]!);
      modelAttributes.add("hue.import.step_id", loaded.step_id);
      modelAttributes.add("hue.import.timing", "recorded_step_instant; call_duration_unavailable");
      modelAttributes.json(SOURCE_RECORD, loaded);
      const model = loaded.model_name ?? t.agent.model_name;
      if (model != null) modelAttributes.add("gen_ai.request.model", model);
      if (loaded.reasoning_content != null)
        modelAttributes.add("hue.import.reasoning_content", loaded.reasoning_content);
      if (loaded.reasoning_effort != null)
        modelAttributes.json("hue.import.reasoning_effort", loaded.reasoning_effort);
      if (loaded.llm_call_count != null)
        modelAttributes.add("hue.import.llm_call_count", loaded.llm_call_count);
      if (t.agent.tool_definitions != null)
        modelAttributes.json("gen_ai.tool.definitions", t.agent.tool_definitions);
      addUsage(modelAttributes, loaded.metrics);
      addSpan({
        spanId: modelId,
        parentSpanId: agentId,
        name: "chat",
        startTimeUnixNano: times[index]!,
        endTimeUnixNano: times[index]!,
        attributes: modelAttributes.finish(),
        status: { code: 0 },
      });
      history.push(output);
      for (const [position, requested] of calls.entries()) {
        const observedIndex = observed.findIndex(
          (entry) => entry.source_call_id === requested.tool_call_id,
        );
        const returned = observed[observedIndex]!;
        // A spawning call stays open until its subagent's last recorded step.
        const children = spawned.get(requested.tool_call_id) ?? [];
        const toolId = spanId([...idParts, "step", loaded.step_id, "tool", requested.tool_call_id]);
        const attributes = new AttributeList(blobs);
        commonOf(attributes, t, agentRole);
        attributes.add("gen_ai.operation.name", "execute_tool");
        attributes.add("gen_ai.tool.name", requested.function_name);
        attributes.add("gen_ai.tool.call.id", requested.tool_call_id);
        attributes.add("gen_ai.tool.type", "function");
        attributes.json("gen_ai.tool.call.arguments", requested.arguments);
        attributes.json("gen_ai.tool.call.result", returned.content);
        attributes.add("hue.tool.call.position", position);
        attributes.add("hue.import.source_index", sourceIndex[index]!);
        attributes.add("hue.import.step_id", loaded.step_id);
        attributes.add("hue.import.observation_index", observedIndex);
        attributes.add(
          "hue.import.timing",
          children.length
            ? "recorded_step_instant_to_last_subagent_step"
            : "recorded_step_instant; tool_duration_unavailable",
        );
        attributes.json(SOURCE_RECORD, { call: requested, observation: returned });
        if (children.length)
          attributes.json(
            "hue.import.subagent_trajectory_ids",
            children.map((sub) => sub.trajectory_id),
          );
        addSpan({
          spanId: toolId,
          parentSpanId: modelId,
          name: requested.function_name,
          startTimeUnixNano: times[index]!,
          endTimeUnixNano: children
            .map((sub) => embedded.get(sub.trajectory_id)!.checked.times.at(-1)!)
            .reduce(laterNanos, times[index]!),
          attributes: attributes.finish(),
          // ATIF records a tool's result text, never its outcome: the span keeps the content and
          // states no error. Any one exporter's failure wording stays in the result it wrote.
          status: { code: 0 },
        });
        for (const sub of children) addSubagent(sub, toolId);
      }
      // The recorded observation order is kept in the next model's conversation, even when
      // parallel calls returned in a different order from their requests.
      for (const returned of observed)
        history.push({
          role: "tool",
          tool_call_id: returned.source_call_id,
          content: returned.content,
        });
    }
  };
  // A subagent is its own agent span under the spawning tool span: it keeps the whole embedded
  // trajectory and the reference that resolved it; each step also keeps its own record.
  const addSubagent = (sub: SubagentTrajectory, parentSpanId: string) => {
    const found = embedded.get(sub.trajectory_id)!;
    const agentId = spanId(["subagent", sub.trajectory_id]);
    const attributes = new AttributeList(blobs);
    commonOf(attributes, sub, "subagent");
    attributes.add("gen_ai.operation.name", "invoke_agent");
    attributes.json("gen_ai.input.messages", inputOf(sub));
    attributes.json("gen_ai.output.messages", replyOf(sub));
    attributes.json(SOURCE_RECORD, sub);
    attributes.json("hue.import.subagent_ref", found.ref);
    attributes.add("hue.import.timing", "first_to_last_recorded_step; call_durations_unavailable");
    addUsage(attributes, finalUsage(sub));
    addSpan({
      spanId: agentId,
      parentSpanId,
      name: agentSpanName(sub),
      startTimeUnixNano: found.checked.start,
      endTimeUnixNano: found.checked.times.at(-1)!,
      attributes: attributes.finish(),
      status: { code: 0 },
    });
    addSteps(sub, found.checked, agentId, ["subagent", sub.trajectory_id], "subagent");
  };
  addSteps(document, main, rootId, [], role);
  // The export's user (`extra.user_id`) as the standard `user.id` on a span of its own, as Hue
  // reads an import's user: a trace imported before it gains it as one new span.
  const userId = atifUserId(document.extra?.user_id);
  if (userId)
    addSpan({
      spanId: spanId(["user"]),
      parentSpanId: rootId,
      name: "hue.import.user",
      startTimeUnixNano: main.start,
      endTimeUnixNano: main.start,
      attributes: [{ key: "user.id", value: { stringValue: userId } }],
      status: { code: 0 },
    });
  const session = identifier(document.session_id, MAX_SESSION);
  return {
    traceId,
    format: "atif",
    entries,
    blobs: blobs.sorted(),
    ...(userId || session
      ? { identity: { ...(userId ? { user: userId } : {}), ...(session ? { session } : {}) } }
      : {}),
    origin: "unknown",
    sourceDigests: new Set(),
    remappedTraceId: false,
    remappedSpans: 0,
  };
}

// --- Batches ----------------------------------------------------------------------------------

export interface PreparedBatch {
  sha256: string;
  body: Uint8Array;
  decodedBytes: number;
  spanIds: string[];
}

/** `Math.floor(numerator / divisor)` for safe nonnegative integers, without a division: the
 * published package's import-boundary check reads a `/` after a name as a regular expression, so
 * the quotient is estimated from the reciprocal and corrected by whole steps, which makes it
 * exact on every engine. */
export function integerQuotient(numerator: number, divisor: number): number {
  let quotient = Math.floor(numerator * divisor ** -1);
  while (quotient * divisor > numerator) quotient--;
  while ((quotient + 1) * divisor <= numerator) quotient++;
  return quotient;
}

const spanIdOf = (entry: ImportEntry): string => {
  const span = entry.scopeSpans[0]?.spans[0];
  return typeof span?.spanId === "string" ? span.spanId : "";
};

/**
 * The trace's entries packed into gzip OTLP/JSON batches in order, each at most 3 MiB decoded
 * and 900 KiB on the wire. Packing is linear and the output depends on the entries alone, so the
 * same trace packs to the same batches whatever bundle it came from.
 */
export function batchEntries(entries: readonly ImportEntry[]): PreparedBatch[] {
  const batches: PreparedBatch[] = [];
  const parts: { json: string; bytes: number }[] = [];
  const encode = (from: number, to: number) => {
    const decoded = Buffer.from(
      `${BATCH_PREFIX}${parts
        .slice(from, to)
        .map((part) => part.json)
        .join(",")}${BATCH_SUFFIX}`,
    );
    return { decoded, body: gzipSync(decoded, { level: 6 }) };
  };
  const commit = (from: number, to: number, encoded: ReturnType<typeof encode>) => {
    if (
      encoded.decoded.byteLength > MAX_BATCH_DECODED_BYTES ||
      encoded.body.byteLength > MAX_BATCH_WIRE_BYTES
    )
      throw new ConversionError("A batch exceeds the import batch bounds");
    // The batch must read back whole: what the receiver decodes is what was packed.
    const readBack = JSON.parse(gunzipSync(encoded.body).toString("utf8")) as {
      resourceSpans: unknown[];
    };
    if (!Array.isArray(readBack.resourceSpans) || readBack.resourceSpans.length !== to - from)
      throw new ConversionError("A batch does not read back whole");
    batches.push({
      sha256: sha256Hex(encoded.body),
      body: encoded.body,
      decodedBytes: encoded.decoded.byteLength,
      spanIds: entries.slice(from, to).map(spanIdOf),
    });
  };
  /** Seals entries from `from`, returning where the next batch starts. */
  const seal = (from: number, to: number) => {
    let end = to;
    let encoded = encode(from, end);
    while (encoded.body.byteLength > MAX_BATCH_WIRE_BYTES) {
      if (end - from === 1) throw new ConversionError("One span exceeds the import batch bounds");
      // Shrink toward the wire cap by the observed compression ratio rather than re-encoding
      // per entry.
      const budget = integerQuotient(
        encoded.decoded.byteLength * MAX_BATCH_WIRE_BYTES * 9,
        encoded.body.byteLength * 10,
      );
      let next = from + 1;
      let bytes = BATCH_FRAME_BYTES + parts[from]!.bytes;
      while (next < end - 1 && bytes + 1 + parts[next]!.bytes <= budget)
        bytes += 1 + parts[next++]!.bytes;
      end = next;
      encoded = encode(from, end);
    }
    commit(from, end, encoded);
    return end;
  };
  let start = 0;
  let pendingBytes = BATCH_FRAME_BYTES;
  let index = 0;
  while (index < entries.length) {
    let part = parts[index];
    if (!part) {
      const json = JSON.stringify(entries[index]);
      part = parts[index] = { json, bytes: Buffer.byteLength(json) };
    }
    if (BATCH_FRAME_BYTES + part.bytes > MAX_BATCH_DECODED_BYTES)
      throw new ConversionError("One span exceeds the import batch bounds");
    const grown = pendingBytes + (index > start ? 1 : 0) + part.bytes;
    if (grown <= MAX_BATCH_DECODED_BYTES) {
      pendingBytes = grown;
      index++;
      continue;
    }
    start = seal(start, index);
    index = start;
    pendingBytes = BATCH_FRAME_BYTES;
  }
  while (start < parts.length) start = seal(start, parts.length);
  return batches;
}

// --- Manifest ---------------------------------------------------------------------------------

export interface ManifestTrace {
  trace_id: string;
  span_count: number;
  batches: { sha256: string; bytes: number; span_count: number }[];
  blobs: { sha256: string; byte_size: number; content_type: string }[];
  identity?: TraceIdentity;
  origin: TraceImportOrigin;
  source_digest?: string;
}
export interface TraceImportManifest {
  version: 1;
  source: { formats: TraceImportFormat[]; helper: string; helper_version?: string };
  traces: ManifestTrace[];
}
export interface TraceImportTotals {
  traces: number;
  batches: number;
  spans: number;
  blobs: number;
  bytes: number;
}

/** The totals a manifest adds up to, as Hue computes them. */
export function manifestTotals(manifest: TraceImportManifest): TraceImportTotals {
  let batches = 0,
    spans = 0,
    blobs = 0,
    bytes = 0;
  for (const trace of manifest.traces) {
    batches += trace.batches.length;
    spans += trace.span_count;
    blobs += trace.blobs.length;
    for (const batch of trace.batches) bytes += batch.bytes;
  }
  return { traces: manifest.traces.length, batches, spans, blobs, bytes };
}

export function manifestTraceHasIdentity(trace: Pick<ManifestTrace, "identity">): boolean {
  return Boolean(trace.identity?.user || trace.identity?.entity);
}

const HEX64 = /^[0-9a-f]{64}$/;
const isCount = (value: unknown, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;

/** A manifest's problem, or undefined: the shape and cross-checks Hue's registration applies
 * (every trace id once, every batch digest once, each trace's batches adding up to its span
 * count, each trace's values distinct) so a bundle is refused here, before any upload. */
export function validateManifest(value: unknown): string | undefined {
  if (!isObject(value)) return "the manifest is not a JSON object";
  if (value.version !== 1) return "the manifest version is not 1";
  if (
    !isObject(value.source) ||
    !Array.isArray(value.source.formats) ||
    !value.source.formats.length ||
    !value.source.formats.every(
      (format) =>
        typeof format === "string" && (traceImportFormats as readonly string[]).includes(format),
    ) ||
    typeof value.source.helper !== "string" ||
    !value.source.helper
  )
    return "the manifest source is malformed";
  if (!Array.isArray(value.traces) || !value.traces.length)
    return "the manifest declares no traces";
  if (value.traces.length > traceImportLimits.traces)
    return `the manifest declares more than ${traceImportLimits.traces} traces`;
  const traceIds = new Set<string>();
  const digests = new Set<string>();
  for (const trace of value.traces as unknown[]) {
    if (!isObject(trace)) return "a declared trace is not an object";
    const id = trace.trace_id;
    if (typeof id !== "string" || !HEX32.test(id) || /^0+$/.test(id))
      return "a declared trace id is not an OpenTelemetry trace id";
    if (traceIds.has(id)) return `the manifest declares trace ${id} more than once`;
    traceIds.add(id);
    if (!isCount(trace.span_count, traceImportLimits.spansPerTrace))
      return `trace ${id} declares an invalid span count`;
    if (
      !Array.isArray(trace.batches) ||
      !trace.batches.length ||
      trace.batches.length > traceImportLimits.batchesPerTrace
    )
      return `trace ${id} declares an invalid batch list`;
    let spans = 0;
    for (const batch of trace.batches as unknown[]) {
      if (
        !isObject(batch) ||
        typeof batch.sha256 !== "string" ||
        !HEX64.test(batch.sha256) ||
        !isCount(batch.bytes, traceImportLimits.batchBytes) ||
        !isCount(batch.span_count, traceImportLimits.spansPerTrace)
      )
        return `trace ${id} declares a malformed batch`;
      if (digests.has(batch.sha256))
        return `the manifest declares batch ${batch.sha256} more than once`;
      digests.add(batch.sha256);
      spans += batch.span_count as number;
    }
    if (spans !== trace.span_count)
      return `trace ${id} declares ${String(trace.span_count)} spans but its batches hold ${spans}`;
    const blobs = trace.blobs ?? [];
    if (!Array.isArray(blobs) || blobs.length > traceImportLimits.blobsPerTrace)
      return `trace ${id} declares an invalid value list`;
    const seen = new Set<string>();
    for (const blob of blobs as unknown[]) {
      if (
        !isObject(blob) ||
        typeof blob.sha256 !== "string" ||
        !HEX64.test(blob.sha256) ||
        !isCount(blob.byte_size, traceImportLimits.blobBytes) ||
        typeof blob.content_type !== "string" ||
        blob.content_type.length < 3 ||
        blob.content_type.length > 255
      )
        return `trace ${id} declares a malformed value`;
      if (seen.has(blob.sha256)) return `trace ${id} lists value ${blob.sha256} more than once`;
      seen.add(blob.sha256);
    }
    if (trace.identity !== undefined) {
      if (!isObject(trace.identity)) return `trace ${id} declares a malformed identity`;
      const { user, entity, session } = trace.identity;
      if (
        (user !== undefined && !identifier(user, MAX_IDENTIFIER)) ||
        (session !== undefined && !identifier(session, MAX_SESSION)) ||
        (entity !== undefined &&
          (!isObject(entity) ||
            !identifier(entity.namespace, MAX_NAMESPACE) ||
            !identifier(entity.id, MAX_IDENTIFIER)))
      )
        return `trace ${id} declares a malformed identity`;
    }
    if (
      trace.origin !== undefined &&
      !(traceImportOrigins as readonly unknown[]).includes(trace.origin)
    )
      return `trace ${id} declares an unknown origin`;
    if (
      trace.source_digest !== undefined &&
      (typeof trace.source_digest !== "string" || !HEX64.test(trace.source_digest))
    )
      return `trace ${id} declares a malformed source digest`;
  }
  return undefined;
}
