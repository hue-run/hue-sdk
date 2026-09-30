import { createContextKey, type Context } from "@opentelemetry/api";

/**
 * Session, user and workspace identifiers carried across a process boundary as W3C `baggage`.
 * Internal: exported from no entry point.
 */
export interface Identity {
  sessionId?: string;
  userId?: string;
  workspaceId?: string;
}

type Carried = Readonly<Identity & { remote: boolean }>;

/** Baggage member names, in the order `inject` writes them. */
export const MEMBER = {
  sessionId: "hue.session.id",
  userId: "hue.user.id",
  workspaceId: "hue.workspace.id",
} as const;

const FIELDS = ["sessionId", "userId", "workspaceId"] as const;
const NAMES: ReadonlySet<string> = new Set(Object.values(MEMBER));
const FIELD_BY_NAME = new Map<string, (typeof FIELDS)[number]>(
  FIELDS.map((field) => [MEMBER[field], field]),
);

/** OpenTelemetry's total baggage size limit; `inject` never writes more and `extract` refuses more. */
const MAX_BAGGAGE_BYTES = 8192;
/** OpenTelemetry's member-count limit for reading. */
const MAX_READ_MEMBERS = 180;
/** The W3C minimum a platform must propagate; `inject` adds no Hue member past it. */
const MAX_WRITE_MEMBERS = 64;
/** OpenTelemetry's per-member size limit. */
const MAX_MEMBER_BYTES = 4096;

/**
 * Hue's own context key. `Symbol.for` underneath, so two SDK copies in one process share it; only
 * `withSpan`, the tracer and an opted-in `extract` set it, never OpenTelemetry `Baggage`.
 */
const IDENTITY_KEY = createContextKey("@hue-run/sdk identity");

/** The SDK's identifier rule: 1–4096 UTF-16 code units, no NUL, no unpaired surrogate. */
function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\u0000") &&
    value.isWellFormed()
  );
}

function valid(source: unknown): Identity {
  const identity: Identity = {};
  if (source === null || typeof source !== "object") return identity;
  for (const field of FIELDS) {
    const value: unknown = (source as Record<string, unknown>)[field];
    if (isIdentifier(value)) identity[field] = value;
  }
  return identity;
}

function isEmpty(identity: Identity): boolean {
  return FIELDS.every((field) => identity[field] === undefined);
}

/**
 * Returns `ctx` carrying `identity` under Hue's key. `remote` marks an identity read by an opted-in
 * `extract`; a local marker replaces a remote one, so a helper's own context is never remote.
 */
export function withIdentity(ctx: Context, identity: Identity, remote: boolean): Context {
  const carried: Carried = Object.freeze({ ...valid(identity), remote });
  return ctx.setValue(IDENTITY_KEY, carried);
}

function carried(ctx: Context | undefined): Carried | undefined {
  const value: unknown = ctx?.getValue(IDENTITY_KEY);
  return value !== null && typeof value === "object" ? (value as Carried) : undefined;
}

/** The identity a context carries under either marker, re-validated. */
export function carriedIdentity(ctx: Context | undefined): Identity | undefined {
  const value = carried(ctx);
  return value === undefined ? undefined : valid(value);
}

/** The identity an opted-in `extract` put on this context, re-validated; none for a local one. */
export function remoteIdentity(ctx: Context | undefined): Identity | undefined {
  const value = carried(ctx);
  if (value?.remote !== true) return undefined;
  const identity = valid(value);
  return isEmpty(identity) ? undefined : identity;
}

/** Percent-encodes every UTF-8 byte outside `ALPHA / DIGIT / "-" / "." / "_" / "~"`, uppercase hex. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const OWS = /^[ \t]+|[ \t]+$/g;
const trimOws = (text: string) => text.replace(OWS, "");

/** A member's key: the text before the first `=` and before any `;`, without optional whitespace. */
function memberKey(member: string): string {
  const equals = member.indexOf("=");
  const head = equals < 0 ? member : member.slice(0, equals);
  const semicolon = head.indexOf(";");
  return trimOws(semicolon < 0 ? head : head.slice(0, semicolon));
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Removes every `hue.session.id`, `hue.user.id` and `hue.workspace.id` member from `existing`, then
 * appends the members for `identity` when they fit. Other members keep their bytes and order; with
 * nothing removed the original value is a prefix of the result. `value` undefined means the key
 * should not exist. `ownMemberTooLong` counts Hue members omitted for exceeding 4,096 bytes; a
 * carrier too crowded to add to is only stripped, and not counted, since forwarded input may
 * have crowded it.
 */
export function mergeIdentityBaggage(
  existing: string | undefined,
  identity: Identity,
): { value?: string; ownMemberTooLong: number } {
  const source = existing ?? "";
  const pieces = source.split(",");
  const kept = pieces.filter((piece) => !NAMES.has(memberKey(piece)));
  const stripped = kept.length !== pieces.length;
  const base = stripped ? kept.join(",") : source;
  const baseMembers = stripped
    ? kept.filter((piece) => trimOws(piece) !== "").length
    : trimOws(source) === ""
      ? 0
      : pieces.filter((piece) => trimOws(piece) !== "").length;
  const own: string[] = [];
  let ownMemberTooLong = 0;
  const resolved = valid(identity);
  for (const field of FIELDS) {
    const value = resolved[field];
    if (value === undefined) continue;
    const member = `${MEMBER[field]}=${encode(value)}`;
    if (member.length > MAX_MEMBER_BYTES) ownMemberTooLong++;
    else own.push(member);
  }
  let value: string | undefined = base;
  if (own.length > 0) {
    const candidate = baseMembers === 0 ? own.join(",") : `${base},${own.join(",")}`;
    if (baseMembers + own.length <= MAX_WRITE_MEMBERS && byteLength(candidate) <= MAX_BAGGAGE_BYTES)
      value = candidate;
  }
  if (!stripped && value === source) return { value: existing, ownMemberTooLong };
  if (trimOws(value).replace(/[ \t,]/g, "") === "") value = undefined;
  return { value, ownMemberTooLong };
}

/** A W3C baggage value with every `%` starting an escape: baggage-octets plus `%XX`. */
const ENCODED_VALUE = /^(?:[\x21\x23\x24\x26-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]|%[0-9A-Fa-f]{2})+$/;

function decode(raw: string): string | undefined {
  if (!ENCODED_VALUE.test(raw)) return undefined;
  try {
    // decodeURIComponent rejects escapes that are not strict UTF-8; `+` stays a literal `+`.
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/**
 * Reads the three Hue members from a carrier's `baggage` value. Untrusted input: a header over
 * 8,192 bytes or 180 members yields nothing, and an invalid or conflicting member drops its field.
 * Nothing is thrown, logged or counted.
 */
export function readIdentityBaggage(value: unknown): Identity | undefined {
  let header: string;
  if (typeof value === "string") header = value;
  else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    header = value.join(",");
  else return undefined;
  if (header.length > MAX_BAGGAGE_BYTES || byteLength(header) > MAX_BAGGAGE_BYTES) return undefined;
  const members = header.split(",");
  if (members.filter((member) => trimOws(member) !== "").length > MAX_READ_MEMBERS)
    return undefined;
  const found: Identity = {};
  const refused = new Set<string>();
  for (const member of members) {
    const equals = member.indexOf("=");
    if (equals < 0) continue;
    const rawKey = member.slice(0, equals);
    if (rawKey.includes(";")) continue;
    const field = FIELD_BY_NAME.get(trimOws(rawKey));
    if (field === undefined) continue;
    const rest = member.slice(equals + 1);
    const semicolon = rest.indexOf(";");
    const decoded = decode(trimOws(semicolon < 0 ? rest : rest.slice(0, semicolon)));
    const previous = found[field];
    // An invalid value, or a second value that differs, fails closed for that field.
    if (!isIdentifier(decoded) || (previous !== undefined && previous !== decoded))
      refused.add(field);
    else found[field] = decoded;
  }
  for (const field of refused) delete found[field as keyof Identity];
  return isEmpty(found) ? undefined : found;
}

/**
 * The carrier's baggage key: `baggage` when present, else the first key equal to it
 * case-insensitively, else `baggage`.
 */
export function baggageKey(carrier: object): string {
  if (Object.hasOwn(carrier, "baggage")) return "baggage";
  return Object.keys(carrier).find((key) => key.toLowerCase() === "baggage") ?? "baggage";
}
