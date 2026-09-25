import { createHash } from "node:crypto";
import { MAX_BODY_BYTES } from "./config.js";

/** Replaces a hosted-tool credential found in an exported tool definition. */
const REDACTED = "[redacted]";

/**
 * Credential keys, compared case-insensitively and ignoring `-` and `_`: OpenAI hosted MCP
 * `authorization` and `headers`, Anthropic MCP `authorization_token`, and common API key fields.
 * Keep this list deliberately broad: provider tool schemas are untrusted input and providers use
 * generic names such as `token`, `secret`, and `password` for hosted credentials.
 */
const credentialKeys = new Set([
  "authorization",
  "authorizationtoken",
  "headers",
  "apikey",
  "accesstoken",
  "xapikey",
  "token",
  "refreshtoken",
  "clientsecret",
  "password",
  "secret",
  "credential",
  "credentials",
]);

/** URL-valued fields in hosted tool and MCP-server definitions can carry credentials in userinfo
 * or query parameters. Query values are all replaced because a provider may use an arbitrary key
 * for its credential and guessing which names are sensitive would leave a leak. */
function isUrlKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return normalized === "serverurl" || normalized === "url";
}

function scrubUrl(value: string, state: ScrubState): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // A malformed URL may still contain a credential. Do not export an opaque URL-valued
    // string when it cannot be parsed safely.
    state.changed = true;
    return REDACTED;
  }

  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  if (url.search) {
    const keys = Array.from(url.searchParams.keys());
    const scrubbed = new URLSearchParams();
    for (const key of keys) scrubbed.append(key, REDACTED);
    url.search = scrubbed.toString();
    changed = true;
  }
  if (url.hash) {
    url.hash = "";
    changed = true;
  }
  if (changed) state.changed = true;
  return changed ? url.toString() : value;
}

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return (
    credentialKeys.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("credential")
  );
}

/** A URL in free text: a scheme, `://` and everything up to whitespace, a quote or `<>`. A quoted
 * value right after `=` (`?token="…"`) is part of the URL, so the whole value is replaced. */
const textUrl =
  /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s"'<>`]|(?<==)"[^"<>`\r\n]*"|(?<==)'[^'<>`\r\n]*'|(?<==)["'])+/gi;
/** Schemes WHATWG parses as hierarchical, which both SDKs serialize alike. */
const specialScheme = /^(?:https?|wss?|ftp):/i;
/** A URL in free text. One with another scheme, which runtimes parse differently, is replaced
 * whole when it could carry userinfo, a query or a fragment. */
function scrubTextUrl(url: string, state: ScrubState): string {
  if (specialScheme.test(url)) return scrubUrl(url, state);
  return /[@?#]/.test(url) ? REDACTED : url;
}
/** An authorization scheme followed by its credential, as in an `Authorization` header. The
 * credential cannot start with `=`, so `token = value` is left to the key-value rule. */
const authorizationValue = /\b(bearer|basic|token)(\s+)[a-z0-9._~+/-][a-z0-9._~+/=-]*/gi;
/** The key and separator of a `key=value` or `key: value` pair, the key optionally quoted. The
 * value is not consumed, so a pair inside another pair's value (`error: token=…`) is found. */
const pairKey = /(["']?)([a-z][a-z0-9_-]{0,63})\1(\s*[:=]\s*)/gi;
/** A quoted value to its closing quote on the same line, spaces and escaped quotes included. */
const quotedValue = /"(?:[^"\\\r\n]|\\[^\r\n])+"|'(?:[^'\\\r\n]|\\[^\r\n])+'/y;
/** An unquoted value, or one whose quote does not close on its line, up to whitespace, a quote or
 * a delimiter; a value already replaced, or a scheme whose credential was, is left alone. */
const bareValue =
  /(["']?)(?!\[redacted\]|%5Bredacted%5D|(?:bearer|basic|token)\s)[^\s"',;&})\]]+/iy;

/** Replaces the value of each pair whose key names a credential. */
function scrubPairs(text: string): string {
  let result = "";
  let copied = 0;
  for (const match of text.matchAll(pairKey)) {
    const start = match.index + match[0].length;
    if (start < copied || !isCredentialKey(match[2]!)) continue;
    quotedValue.lastIndex = start;
    bareValue.lastIndex = start;
    const quoted = quotedValue.exec(text);
    const value = quoted ?? bareValue.exec(text);
    if (!value) continue;
    const quote = quoted ? quoted[0][0]! : value[1]!;
    result += `${text.slice(copied, start)}${quote}${REDACTED}${quoted ? quote : ""}`;
    copied = start + value[0].length;
  }
  return result + text.slice(copied);
}

/**
 * Removes credentials from free text a provider returned, such as an MCP call's error message,
 * with the rules tool definitions use: each `http`, `https`, `ws`, `wss` or `ftp` URL loses its
 * userinfo and fragment and every query value becomes `[redacted]`, as a `url` field does (an
 * unparseable one becomes `[redacted]`), and a URL with any other scheme becomes `[redacted]` when
 * it has an `@`, `?` or `#`;
 * the credential after an authorization scheme (`Bearer`, `Basic`, `Token`) and the value of a
 * `key=value` or `key: value` pair whose key names a credential (a quoted value to its closing
 * quote) become `[redacted]`.
 */
export function scrubCredentialText(text: string): string {
  const state: ScrubState = { changed: false };
  return scrubPairs(
    text
      .replace(textUrl, (url) => scrubTextUrl(url, state))
      .replace(authorizationValue, `$1$2${REDACTED}`),
  );
}

/** OpenInference records each tool as `llm.tools.{index}.tool.json_schema`. */
const openInferenceTool = /^llm\.tools\.(\d+)\.tool\.json_schema$/;

interface ScrubState {
  changed: boolean;
}

/**
 * Replaces the value of every credential key at any depth. Keys directly inside a JSON Schema
 * `properties` object name tool parameters (a tool may take a `headers` argument), so their
 * schemas are kept and scrubbed like any other value.
 */
function scrubNode(
  value: unknown,
  state: ScrubState,
  depth: number,
  parameters: boolean,
  credentialParameter = false,
): unknown {
  if (depth > 256) throw new Error("Tool definition exceeds the supported nesting limit");
  if (Array.isArray(value))
    return value.map((item) => scrubNode(item, state, depth + 1, false, credentialParameter));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (credentialParameter && ["examples", "enum"].includes(key)) {
        state.changed = true;
        return [key, Array.isArray(item) ? item.map(() => REDACTED) : REDACTED];
      }
      if (credentialParameter && ["default", "const"].includes(key)) {
        state.changed = true;
        return [key, REDACTED];
      }
      if (!parameters && item !== null && isCredentialKey(key)) {
        state.changed = true;
        return [key, REDACTED];
      }
      if (!parameters && typeof item === "string" && isUrlKey(key))
        return [key, scrubUrl(item, state)];
      return [
        key,
        scrubNode(
          item,
          state,
          depth + 1,
          key === "properties",
          key === "properties"
            ? false
            : credentialParameter || (parameters && isCredentialKey(key)),
        ),
      ];
    }),
  );
}

/**
 * Parses JSON text, returning `undefined` for text that is not JSON. Oversized text is parsed too:
 * the caller's `redact` runs afterwards and may shorten it enough to export.
 */
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** A JSON-encoded tool definition, or list of them, with its credentials replaced. */
function scrubDefinitionText(text: string): string {
  const parsed = parse(text);
  if (parsed === null || typeof parsed !== "object") return text;
  const state = { changed: false };
  const scrubbed = scrubNode(parsed, state, 0, false);
  return state.changed ? JSON.stringify(scrubbed) : text;
}

/**
 * A raw provider request or response recorded as JSON (OpenInference `input.value`,
 * `output.value` and `llm.invocation_parameters`), with credentials replaced in its `tools` and
 * `mcp_servers` entries only; nothing else in the value changes.
 */
function scrubRequestText(text: string): string {
  if (!text.includes('"tools"') && !text.includes('"mcp_servers"')) return text;
  const parsed = parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return text;
  const state = { changed: false };
  const request = { ...(parsed as Record<string, unknown>) };
  for (const field of ["tools", "mcp_servers"])
    if (request[field] !== null && typeof request[field] === "object")
      request[field] = scrubNode(request[field], state, 0, false);
  return state.changed ? JSON.stringify(request) : text;
}

/**
 * Removes hosted-tool credentials from an exported attribute value, before the caller's `redact`.
 * Tool definitions come from OpenTelemetry GenAI (`gen_ai.tool.definitions`), AI SDK 6
 * (`ai.prompt.tools`, one JSON string per tool) and OpenInference (`llm.tools.{i}.tool.json_schema`,
 * plus the raw request in `input.value`). Other attributes, and values that are not JSON, are
 * returned unchanged. Metadata-only export removes all of these attributes anyway.
 *
 * @throws Error when a tool definition is nested too deeply to inspect; the record is then
 * rejected rather than exported with credentials.
 */
export function scrubToolCredentials(key: string, value: unknown): unknown {
  const scrub =
    key === "gen_ai.tool.definitions" || key === "ai.prompt.tools" || openInferenceTool.test(key)
      ? scrubDefinitionText
      : key === "input.value" || key === "output.value" || key === "llm.invocation_parameters"
        ? scrubRequestText
        : undefined;
  if (!scrub) return value;
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value))
    return value.map((item: unknown) => (typeof item === "string" ? scrub(item) : item));
  return value;
}

/** A usable tool name: non-blank, at most 256 characters, well-formed and free of NUL. */
function isName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= 256 &&
    !value.includes("\u0000") &&
    value.isWellFormed()
  );
}

/**
 * A definition's name: `name` (GenAI, AI SDK, Responses and Anthropic tools), else Chat
 * Completions' `function.name`, else the `type` of an unnamed built-in tool such as `mcp`.
 */
function toolName(definition: unknown): string | undefined {
  if (definition === null || typeof definition !== "object" || Array.isArray(definition))
    return undefined;
  const { name, function: fn, type } = definition as Record<string, unknown>;
  const nested =
    fn !== null && typeof fn === "object" ? (fn as Record<string, unknown>).name : undefined;
  return [name, nested, type].find(isName);
}

/**
 * Parses JSON-encoded definitions; `undefined` unless every element is a JSON object or array.
 * Like the Python SDK, which parses on the application thread, definitions longer than one
 * export request are not parsed, so both SDKs summarize the same records.
 */
function parseDefinitions(texts: unknown[]): unknown[] | undefined {
  const length = texts.reduce<number>(
    (total, text) => total + (typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0),
    0,
  );
  if (length > MAX_BODY_BYTES) return undefined;
  const parsed = texts.map((text) => (typeof text === "string" ? parse(text) : undefined));
  return parsed.every((item) => item !== null && typeof item === "object") ? parsed : undefined;
}

/**
 * The tool definitions a record carries, in order: `gen_ai.tool.definitions` (one JSON list),
 * else AI SDK 6 `ai.prompt.tools` (one JSON string per tool), else OpenInference
 * `llm.tools.{i}.tool.json_schema` ordered by index.
 */
function definitionsOf(source: Record<string, unknown>): unknown[] | undefined {
  const definitions = source["gen_ai.tool.definitions"];
  if (definitions !== undefined) {
    const parsed = parseDefinitions([definitions])?.[0];
    return parsed === undefined ? undefined : Array.isArray(parsed) ? parsed : [parsed];
  }
  const promptTools = source["ai.prompt.tools"];
  if (promptTools !== undefined)
    return parseDefinitions(Array.isArray(promptTools) ? promptTools : [promptTools]);
  const indexed = Object.entries(source)
    .flatMap(([key, value]) => {
      const match = openInferenceTool.exec(key);
      return match ? [[Number(match[1]), value] as const] : [];
    })
    .sort(([left], [right]) => left - right);
  return indexed.length ? parseDefinitions(indexed.map(([, value]) => value)) : undefined;
}

/**
 * RFC 8785 (JCS) canonical JSON: object keys sorted by UTF-16 code units, no whitespace, and
 * ECMAScript number and string serialization. The Python SDK produces the same text.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Metadata-only summary of the tool definitions a record carries, which export then removes:
 * `hue.tool.names` lists each definition's name in order, and `hue.tool.definitions.sha256` is
 * the lowercase hex SHA-256 of the RFC 8785 canonical JSON of the credential-scrubbed definition
 * list, so the same catalog has the same digest in both SDKs and across credential rotation.
 * Returns the source unchanged when it has no parseable definitions; attributes the source
 * already sets are kept.
 */
export function withToolCatalogSummary<T extends Record<string, unknown>>(source: T): T {
  let summary: Record<string, unknown>;
  try {
    const definitions = definitionsOf(source);
    if (definitions === undefined) return source;
    const scrubbed = scrubNode(definitions, { changed: false }, 0, false);
    const names = definitions.map(toolName).filter((name) => name !== undefined);
    summary = {
      ...(names.length ? { "hue.tool.names": names } : {}),
      "hue.tool.definitions.sha256": createHash("sha256")
        .update(canonicalJson(scrubbed), "utf8")
        .digest("hex"),
    };
  } catch {
    // Metadata-only export removes the definitions whether or not they can be summarized.
    return source;
  }
  return { ...summary, ...source } as T;
}

/**
 * The metadata-only summary of one JSON-encoded definition list: `hue.tool.names` and
 * `hue.tool.definitions.sha256`, exactly as export summarizes a record's
 * `gen_ai.tool.definitions`. Empty when the list cannot be summarized.
 */
export function toolCatalogSummary(definitions: string): Record<string, string | string[]> {
  const summarized: Record<string, unknown> = withToolCatalogSummary({
    "gen_ai.tool.definitions": definitions,
  });
  const summary: Record<string, string | string[]> = {};
  for (const key of ["hue.tool.names", "hue.tool.definitions.sha256"])
    if (key in summarized) summary[key] = summarized[key] as string | string[];
  return summary;
}
