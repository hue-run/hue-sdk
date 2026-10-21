import {
  digestHex,
  isObject,
  type ConvertedTrace,
  type ImportEntry,
  type JsonValue,
  type OtlpAttribute,
  type OtlpValue,
  type TraceIdentity,
} from "../traces-import-convert.js";

/**
 * Who a trace ran for and which conversation it belongs to, read the way Hue reads a trace it
 * receives, so the manifest's identity and the report's `without_identity` say what Hue will
 * capture. Two parts, both copied from Hue's reader and kept in its order:
 *
 * - The identity registry: the attributes and metadata fields instrumentations name a user or a
 *   conversation by, first present wins on a record.
 * - The owner rule: a trace's local roots (no parent, or a parent outside the trace) speak first;
 *   when they name nobody, the agent's other spans do. A tool span and everything beneath it never
 *   name the owner. Every carrier at the deciding step must agree, and an explicit
 *   `hue.world.entity.*` declaration wins over users.
 *
 * `--user-key` and `--session-key` name the identity of exports whose user sits under a key of
 * their own; see {@link parseKeyPath} and {@link applyIdentityKeys}.
 */

/** Dedicated attributes, in precedence order. */
const DEDICATED = {
  user: [
    "user.id",
    "enduser.id",
    "hue.user.id",
    "ai.telemetry.metadata.userId",
    "langfuse.user.id",
    "enduser.pseudo.id",
    "mlflow.trace.user",
    "mastra.metadata.resourceId",
  ],
  session: [
    "gen_ai.conversation.id",
    "session.id",
    "hue.session.id",
    "ai.telemetry.metadata.sessionId",
    "langfuse.session.id",
    "mlflow.trace.session",
  ],
} as const;

/** Metadata maps an instrumentation lets the application fill, flattened under the map's prefix
 * or recorded whole as one JSON object, in precedence order. */
const METADATA_MAPS = [
  "ai.telemetry.metadata",
  "ai.settings.context",
  "ai.telemetry.metadata.raindrop",
  "ai.telemetry.metadata.raindrop.ai",
  "traceloop.association.properties",
  "ai.telemetry.metadata.traceloop.association.properties",
  "langfuse.trace.metadata",
  "langfuse.observation.metadata",
  "langsmith.metadata",
  "braintrust.metadata",
  "mastra.metadata",
  "metadata",
] as const;

/** Bare keys, read last: Logfire's baggage stamps them on every span it opens. */
const BARE = { user: ["user_id"], session: ["session_id"] } as const;

/** The field names applications give a user or a conversation inside those maps. */
const FIELDS = {
  user: ["userId", "user_id", "langfuse_user_id"],
  session: [
    "sessionId",
    "session_id",
    "threadId",
    "thread_id",
    "conversationId",
    "conversation_id",
    "convoId",
    "convo_id",
    "langfuse_session_id",
  ],
} as const;

export type IdentityKind = keyof typeof DEDICATED;

/** `metadata` marks a key flattened from a metadata map, whose value may be JSON text. */
interface Candidate {
  key: string;
  field?: string;
  metadata?: true;
}

function candidates(kind: IdentityKind): readonly Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const add = (candidate: Candidate) => {
    const id = `${candidate.key}\u0000${candidate.field ?? ""}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(candidate);
  };
  for (const key of DEDICATED[kind]) add({ key });
  for (const map of METADATA_MAPS)
    for (const field of FIELDS[kind]) {
      add({ key: `${map}.${field}`, metadata: true });
      add({ key: map, field });
    }
  for (const key of BARE[kind]) add({ key });
  return out;
}

const CANDIDATES: Record<IdentityKind, readonly Candidate[]> = {
  user: candidates("user"),
  session: candidates("session"),
};

/** Every attribute Hue reads a user, a conversation or an explicit owner from. */
const IDENTITY_KEYS = new Set([
  ...[...CANDIDATES.user, ...CANDIDATES.session].map((candidate) => candidate.key),
  "hue.world.entity.id",
  "hue.world.entity.namespace",
]);

/** Whether Hue reads an owner or a conversation from an attribute of this name. */
export const namesIdentity = (key: string): boolean => IDENTITY_KEYS.has(key);

/** A JSON object recorded as text is parsed only while it is this short. */
const MAX_METADATA_TEXT = 64 * 1024;

/** An identifier as recorded: a non-blank string, or an integer as its decimal text. */
export function identityText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/** A flattened metadata value: Langfuse's SDKs record each one as JSON text, a string included. */
function metadataText(value: unknown): string | undefined {
  if (
    typeof value === "string" &&
    value.length >= 2 &&
    value.startsWith('"') &&
    value.endsWith('"')
  )
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return identityText(parsed);
    } catch {
      // Not JSON text: the quotes are part of the identifier.
    }
  return identityText(value);
}

/** A JSON object, or one recorded as JSON text while it is short enough to parse. */
function metadataObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    if (value.length > MAX_METADATA_TEXT || !/^\s*\{/.test(value)) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return isObject(value) ? value : undefined;
}

/** Claude Code records a random per-installation `user.id` beside the account it runs under
 * (`user.account_uuid`); there `user.id` names a machine, so the next key is read instead. */
const installationUser = (key: string, read: (key: string) => unknown) =>
  key === "user.id" && read("user.account_uuid") !== undefined;

/** The record's `kind` identifier: the first registry key it carries. `read` answers an
 * attribute in source form (an int64 as its decimal text, a kvlist as an object). */
export function readIdentity(
  kind: IdentityKind,
  read: (key: string) => unknown,
): string | undefined {
  const objects = new Map<string, Record<string, unknown> | undefined>();
  for (const candidate of CANDIDATES[kind]) {
    if (candidate.field === undefined) {
      if (installationUser(candidate.key, read)) continue;
      const recorded = read(candidate.key);
      const value = candidate.metadata ? metadataText(recorded) : identityText(recorded);
      if (value !== undefined) return value;
      continue;
    }
    if (!objects.has(candidate.key))
      objects.set(candidate.key, metadataObject(read(candidate.key)));
    const value = identityText(objects.get(candidate.key)?.[candidate.field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

// --- Reading emitted spans ---------------------------------------------------------------------

/** An OTLP value in source form: an int64 stays its decimal text, a kvlist becomes an object.
 * A value of no OTLP shape (a recorded span need not have one) is null. */
function sourceValue(value: unknown): JsonValue {
  if (!isObject(value)) return null;
  const { stringValue, boolValue, doubleValue, intValue, bytesValue } = value as OtlpValue;
  if (typeof stringValue === "string") return stringValue;
  if (typeof boolValue === "boolean") return boolValue;
  if (typeof doubleValue === "number") return doubleValue;
  if (typeof intValue === "string" || typeof intValue === "number") return String(intValue);
  if (typeof bytesValue === "string") return bytesValue;
  const list = (field: "arrayValue" | "kvlistValue"): unknown[] | undefined => {
    const holder = value[field];
    const values = isObject(holder) ? holder.values : undefined;
    return Array.isArray(values) ? values : isObject(holder) ? [] : undefined;
  };
  const array = list("arrayValue");
  if (array) return array.map(sourceValue);
  const kvlist = list("kvlistValue");
  if (kvlist)
    return Object.fromEntries(
      kvlist.flatMap((item) =>
        isObject(item) && typeof item.key === "string" ? [[item.key, sourceValue(item.value)]] : [],
      ),
    );
  return null;
}

function sourceMap(attributes: unknown): Map<string, JsonValue> {
  const map = new Map<string, JsonValue>();
  if (!Array.isArray(attributes)) return map;
  for (const item of attributes as unknown[])
    if (isObject(item) && typeof item.key === "string" && isObject(item.value))
      map.set(item.key, sourceValue(item.value));
  return map;
}

const text = (map: ReadonlyMap<string, JsonValue>, key: string) => {
  const value = map.get(key);
  return typeof value === "string" && value ? value : undefined;
};

const OPERATION_KEYS = [
  "gen_ai.operation.name",
  "openinference.span.kind",
  "traceloop.span.kind",
  "ai.operationId",
  "operation.name",
  "langfuse.observation.type",
];
const TOOL_OPERATIONS = new Set(["tool", "execute_tool", "ai.toolcall"]);

/** Whether Hue reads the span as a tool call: its operation names one, or an instrumentation
 * convention reads a tool from its attributes. */
export function isToolSpan(attributes: ReadonlyMap<string, JsonValue>): boolean {
  let operation: string | undefined;
  for (const key of OPERATION_KEYS) if ((operation = text(attributes, key))) break;
  if (operation && TOOL_OPERATIONS.has(operation.toLowerCase())) return true;
  if (
    text(attributes, "gen_ai.tool.name") ||
    text(attributes, "gen_ai.tool.call.id") ||
    attributes.has("gen_ai.tool.call.arguments") ||
    attributes.has("gen_ai.tool.call.result")
  )
    return true;
  if (
    text(attributes, "ai.toolCall.name") ||
    text(attributes, "ai.toolCall.id") ||
    attributes.has("ai.toolCall.args") ||
    attributes.has("ai.toolCall.result")
  )
    return true;
  const kind = text(attributes, "openinference.span.kind")?.toUpperCase();
  if (kind === "TOOL" || (kind === undefined && text(attributes, "tool.name"))) return true;
  if (
    text(attributes, "traceloop.span.kind") === "tool" &&
    (text(attributes, "traceloop.entity.name") ||
      attributes.has("traceloop.entity.input") ||
      attributes.has("traceloop.entity.output"))
  )
    return true;
  return (
    text(attributes, "langfuse.observation.type") === "tool" &&
    (attributes.has("langfuse.observation.input") || attributes.has("langfuse.observation.output"))
  );
}

/** One span of a trace as the owner rule sees it. */
export interface SpanView {
  spanId: string;
  parentSpanId?: string;
  start: bigint;
  attributes: Map<string, JsonValue>;
  resource: Map<string, JsonValue>;
  /** The span object as emitted, for a key path into it. */
  span: Record<string, unknown>;
}

export function spanViews(entries: readonly ImportEntry[]): SpanView[] {
  return entries.flatMap((entry) => {
    const span = entry.scopeSpans[0]?.spans[0];
    if (!span || typeof span.spanId !== "string") return [];
    const parent = span.parentSpanId;
    let start = 0n;
    if (typeof span.startTimeUnixNano === "string" && /^\d+$/.test(span.startTimeUnixNano))
      start = BigInt(span.startTimeUnixNano);
    return [
      {
        spanId: span.spanId,
        ...(typeof parent === "string" && parent ? { parentSpanId: parent } : {}),
        start,
        attributes: sourceMap(span.attributes),
        resource: sourceMap(isObject(entry.resource) ? entry.resource.attributes : undefined),
        span,
      },
    ];
  });
}

const ENTITY_ID = "hue.world.entity.id";
const ENTITY_NAMESPACE = "hue.world.entity.namespace";
const MAX_IDENTIFIER_BYTES = 16_384;
const MAX_NAMESPACE_BYTES = 128;
const MAX_SESSION = 2_048;

const validIdentifier = (value: string, bytes: number) =>
  Buffer.byteLength(value) <= bytes && !value.includes("\0") && value.isWellFormed();

type Owner = { kind: "entity"; namespace: string; id: string } | { kind: "user"; id: string };

interface Carrier {
  explicit: Owner[];
  users: Owner[];
  invalid: boolean;
}

/** One step's verdict: explicit entities win over users, and every carrier must agree. A step
 * that names nobody answers nothing, so the next step is read. */
function decideStep(carriers: readonly Carrier[]): Owner | "none" | undefined {
  if (carriers.some((carrier) => carrier.invalid)) return "none";
  const explicit = carriers.flatMap((carrier) => carrier.explicit);
  const found = explicit.length ? explicit : carriers.flatMap((carrier) => carrier.users);
  if (!found.length) return undefined;
  const unique = new Set(found.map((owner) => JSON.stringify(owner)));
  return unique.size === 1 ? found[0] : "none";
}

/** The ids of the spans `marked` picks and of every span beneath one, walked from them down
 * without recursion; a parent chain that closes on itself reaches nothing marked on its own. */
export function subtreeIds<T extends { spanId: string; parentSpanId?: string }>(
  spans: readonly T[],
  marked: (span: T) => boolean,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const span of spans) {
    if (span.parentSpanId === undefined) continue;
    const held = children.get(span.parentSpanId);
    if (held) held.push(span.spanId);
    else children.set(span.parentSpanId, [span.spanId]);
  }
  const found = new Set<string>();
  const pending = spans.filter(marked).map((span) => span.spanId);
  while (pending.length) {
    const id = pending.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    for (const child of children.get(id) ?? []) pending.push(child);
  }
  return found;
}

/** The spans the agent itself recorded, split into local roots and the rest: a tool span and
 * every span beneath one are left out. */
export function agentSpans<T extends { spanId: string; parentSpanId?: string }>(
  spans: readonly T[],
  tool: (span: T) => boolean,
): { roots: T[]; others: T[] } {
  const ids = new Set(spans.map((span) => span.spanId));
  const underTool = subtreeIds(spans, tool);
  const roots: T[] = [];
  const others: T[] = [];
  for (const span of spans) {
    if (underTool.has(span.spanId)) continue;
    if (span.parentSpanId === undefined || !ids.has(span.parentSpanId)) roots.push(span);
    else others.push(span);
  }
  return { roots, others };
}

/** The owner of a set of carriers split as {@link agentSpans} splits them: the roots' verdict,
 * else the other spans'. */
function decideOwner(roots: readonly Carrier[], others: readonly Carrier[]): Owner | undefined {
  const fromRoots = decideStep(roots);
  if (fromRoots !== undefined) return fromRoots === "none" ? undefined : fromRoots;
  const fromOthers = decideStep(others);
  return fromOthers === "none" ? undefined : fromOthers;
}

/** What one span says about the owner: its explicit entity declarations and its registry user,
 * from its own attributes, else its resource's. */
function carrierOf(view: SpanView): Carrier {
  const carrier: Carrier = { explicit: [], users: [], invalid: false };
  for (const values of [view.attributes, view.resource]) {
    const id = text(values, ENTITY_ID);
    const namespace = text(values, ENTITY_NAMESPACE);
    if (!id && !namespace) continue;
    if (
      !id ||
      !namespace ||
      !validIdentifier(id, MAX_IDENTIFIER_BYTES) ||
      !validIdentifier(namespace, MAX_NAMESPACE_BYTES)
    )
      carrier.invalid = true;
    else carrier.explicit.push({ kind: "entity", namespace, id });
  }
  for (const values of [view.attributes, view.resource]) {
    const user = readIdentity("user", (key) => values.get(key));
    if (user === undefined) continue;
    if (validIdentifier(user, MAX_IDENTIFIER_BYTES)) carrier.users.push({ kind: "user", id: user });
    else carrier.invalid = true;
    break;
  }
  return carrier;
}

const byStart = (a: SpanView, b: SpanView) =>
  a.start < b.start ? -1 : a.start > b.start ? 1 : a.spanId < b.spanId ? -1 : 1;

/** The trace's session as Hue's trace list takes it: the earliest local root's, else the earliest
 * span carrying one. */
function sessionOf(views: readonly SpanView[]): string | undefined {
  const ids = new Set(views.map((view) => view.spanId));
  const ordered = [...views].sort(byStart);
  const root = ordered.find((view) => !view.parentSpanId || !ids.has(view.parentSpanId));
  for (const view of root ? [root, ...ordered] : ordered) {
    const session = readIdentity("session", (key) => view.attributes.get(key));
    if (
      session !== undefined &&
      session.length <= MAX_SESSION &&
      validIdentifier(session, Infinity)
    )
      return session;
  }
  return undefined;
}

/** The trace's identity as Hue will capture it from these spans: the owner (an explicit entity or
 * a user) and the session. */
export function traceIdentity(entries: readonly ImportEntry[]): TraceIdentity | undefined {
  const views = spanViews(entries);
  const { roots, others } = agentSpans(views, (view) => isToolSpan(view.attributes));
  const owner = decideOwner(roots.map(carrierOf), others.map(carrierOf));
  const session = sessionOf(views);
  const identity: TraceIdentity = {
    ...(owner?.kind === "user" ? { user: owner.id } : {}),
    ...(owner?.kind === "entity" ? { entity: { namespace: owner.namespace, id: owner.id } } : {}),
    ...(session !== undefined ? { session } : {}),
  };
  return identity.user || identity.entity || identity.session ? identity : undefined;
}

// --- --user-key and --session-key --------------------------------------------------------------

/** Where `--user-key` or `--session-key` reads: a JSON path into a span's source record, or a
 * dotted key looked up on the span and its record. */
export type KeyPath =
  | { kind: "pointer"; segments: string[]; text: string }
  | { kind: "dotted"; key: string; text: string };

export interface IdentityKeys {
  user?: KeyPath;
  session?: KeyPath;
}

const MAX_KEY_PATH = 512;

/**
 * A key path from its command-line text, or undefined when it is malformed:
 * - `/a/b` is a JSON Pointer into the source record (`~1` for `/`, `~0` for `~`);
 * - `$.a.b`, `$.a["b.c"]` or `$.a[0]` is a JSONPath of members and indexes into the record;
 * - anything else is a dotted key: an attribute of the span or its resource, then a key of the
 *   record's metadata (exact, then as a dotted path), then of the record itself.
 */
export function parseKeyPath(text: string): KeyPath | undefined {
  if (!text || text.length > MAX_KEY_PATH || [...text].some((char) => char < " ")) return undefined;
  if (text.startsWith("/"))
    return {
      kind: "pointer",
      segments: text
        .slice(1)
        .split("/")
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")),
      text,
    };
  if (text.startsWith("$")) {
    const segments: string[] = [];
    let rest = text.slice(1);
    while (rest) {
      const member = /^\.([^.[\]]+)/.exec(rest);
      const quoted = /^\[(?:"((?:[^"\\]|\\.)*)"|'([^'\\]*)')\]/.exec(rest);
      const index = /^\[(\d+)\]/.exec(rest);
      const match = member ?? quoted ?? index;
      if (!match) return undefined;
      if (quoted && quoted[1] !== undefined) {
        try {
          segments.push(JSON.parse(`"${quoted[1]}"`) as string);
        } catch {
          return undefined;
        }
      } else segments.push((match[1] ?? match[2])!);
      rest = rest.slice(match[0].length);
    }
    return segments.length ? { kind: "pointer", segments, text } : undefined;
  }
  return text.trim() === text ? { kind: "dotted", key: text, text } : undefined;
}

/** A member of a JSON value, reading into a JSON object or list recorded as text. */
function member(value: unknown, segment: string): unknown {
  if (typeof value === "string" && value.length <= MAX_METADATA_TEXT && /^\s*[{[]/.test(value))
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  if (Array.isArray(value)) return /^\d+$/.test(segment) ? value[Number(segment)] : undefined;
  return isObject(value) && Object.hasOwn(value, segment) ? value[segment] : undefined;
}

const walk = (value: unknown, segments: readonly string[]) =>
  segments.reduce<unknown>((current, segment) => member(current, segment), value);

/** What a key path names on one span, as an identifier. */
export function resolveKey(
  path: KeyPath,
  view: { attributes: ReadonlyMap<string, unknown>; resource?: ReadonlyMap<string, unknown> },
  record: unknown,
  metadata?: unknown,
): string | undefined {
  if (path.kind === "pointer") return metadataText(walk(record, path.segments));
  const dotted = path.key.split(".");
  for (const found of [
    () => view.attributes.get(path.key),
    () => view.resource?.get(path.key),
    () => member(metadata, path.key),
    () => walk(metadata, dotted),
    () => member(record, path.key),
    () => walk(record, dotted),
  ]) {
    const value = metadataText(found());
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The single value a key names across the agent's spans: the roots' when they name one, else
 * the other spans'; spans that disagree name nothing. */
export function decideKey<T extends { spanId: string; parentSpanId?: string }>(
  spans: readonly T[],
  tool: (span: T) => boolean,
  value: (span: T) => string | undefined,
): { found: boolean; value?: string } {
  const { roots, others } = agentSpans(spans, tool);
  for (const step of [roots, others]) {
    const values = new Set(step.flatMap((span) => value(span) ?? []));
    if (values.size === 1) return { found: true, value: [...values][0]! };
    if (values.size > 1) return { found: true };
  }
  return { found: false };
}

/** A span's source record: the vendor record an importer kept whole, else the span itself. */
function recordOf(view: SpanView): unknown {
  const kept = view.attributes.get("hue.import.source_record");
  if (typeof kept === "string" && kept.length <= 16 * MAX_METADATA_TEXT)
    try {
      return JSON.parse(kept);
    } catch {
      // Kept text that is not JSON: the span is the record.
    }
  return view.span;
}

/**
 * Applies `--user-key` and `--session-key` to a trace whose spans are kept as converted (OTLP,
 * Langfuse, ATIF): a span's bytes never change, so a trace also sent live does not conflict.
 * When a key names one user across the agent's spans and the trace names no owner, a child span
 * `hue.import.user` with the single attribute `user.id` is added under the agent's earliest local
 * root (never a tool span), which Hue reads as one of the agent's spans; `hue.import.session` with
 * `gen_ai.conversation.id` likewise names a session the trace lacks. An owner the spans already
 * name is kept: Hue reads it before any added span.
 */
export function applyIdentityKeys(trace: ConvertedTrace, keys: IdentityKeys): void {
  if (!keys.user && !keys.session) return;
  const views = spanViews(trace.entries);
  if (!views.length) return;
  const records = new Map(views.map((view) => [view, recordOf(view)]));
  const tool = (view: SpanView) => isToolSpan(view.attributes);
  const current = traceIdentity(trace.entries);
  const ids = new Set(views.map((view) => view.spanId));
  // The added span goes under the agent's earliest local root, where Hue reads it: never under a
  // tool span, whose subtree never names the owner. A trace whose every span is a tool's, or
  // whose parents close on themselves, has no such root and gains nothing.
  const [root] = agentSpans(views, tool).roots.sort(byStart);
  if (!root) return;
  const rootEntry = trace.entries.find((entry) => entry.scopeSpans[0]?.spans[0] === root.span);
  const add = (name: string, attribute: OtlpAttribute) => {
    let spanId = digestHex(`${name}:${trace.traceId}`, 16);
    for (let salt = 0; ids.has(spanId) || /^0+$/.test(spanId); salt++)
      spanId = digestHex(`${name}:${trace.traceId}:${salt}`, 16);
    ids.add(spanId);
    const start = String(root.span.startTimeUnixNano);
    trace.entries.push({
      resource: isObject(rootEntry?.resource) ? rootEntry.resource : { attributes: [] },
      scopeSpans: [
        {
          scope: { name: "hue.import" },
          spans: [
            {
              traceId: trace.traceId,
              spanId,
              parentSpanId: root.spanId,
              name,
              kind: 1,
              startTimeUnixNano: start,
              endTimeUnixNano: start,
              attributes: [attribute],
              status: { code: 0 },
            },
          ],
        },
      ],
    });
  };
  for (const [kind, path] of [
    ["user", keys.user],
    ["session", keys.session],
  ] as const) {
    if (!path) continue;
    const decided = decideKey(views, tool, (view) =>
      resolveKey(path, view, records.get(view), member(records.get(view), "metadata")),
    );
    if (decided.value === undefined) continue;
    if (kind === "user" && !current?.user && !current?.entity)
      add("hue.import.user", { key: "user.id", value: { stringValue: decided.value } });
    if (kind === "session" && !current?.session)
      add("hue.import.session", {
        key: "gen_ai.conversation.id",
        value: { stringValue: decided.value },
      });
  }
}
