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

/** OpenInference records each tool as `llm.tools.{index}.tool.json_schema`. */
const openInferenceTool = /^llm\.tools\.\d+\.tool\.json_schema$/;

interface ScrubState {
  changed: boolean;
}

/**
 * Replaces the value of every credential key at any depth. Keys directly inside a JSON Schema
 * `properties` object name tool parameters (a tool may take a `headers` argument), so their
 * schemas are kept and scrubbed like any other value.
 */
function scrubNode(value: unknown, state: ScrubState, depth: number, parameters: boolean): unknown {
  if (depth > 256) throw new Error("Tool definition exceeds the supported nesting limit");
  if (Array.isArray(value)) return value.map((item) => scrubNode(item, state, depth + 1, false));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!parameters && item !== null && isCredentialKey(key)) {
        state.changed = true;
        return [key, REDACTED];
      }
      if (!parameters && typeof item === "string" && isUrlKey(key))
        return [key, scrubUrl(item, state)];
      return [key, scrubNode(item, state, depth + 1, key === "properties")];
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
