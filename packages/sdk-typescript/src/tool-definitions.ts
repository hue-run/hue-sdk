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

/** Whether a field name names a credential: one of `credentialKeys`, or a name ending in `token`,
 * `secret`, `password`, `apikey` or `credential`, ignoring case, `-` and `_`. */
export function isCredentialKey(key: string): boolean {
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

/** One piece of a value between backslash-escaped quotes (JSON inside a JSON string): a character,
 * or a whole run of backslashes with what it escapes. The run's length decides what it is: after
 * 4m backslashes, three more and the quote are the inner text's escaped quote, one or three more
 * escape another character, two more (or none, after at least four) are escaped backslashes. Each
 * run can be read only one way, so a value that does not close is given up in linear time; 4m + 1
 * backslashes and the quote close it. `line` holds the characters that end a value's line. */
const escapedUnit = (quote: string, line = String.raw`\r\n`) =>
  String.raw`[^${quote}\\${line}]|(?:\\\\\\\\)*(?:\\\\\\${quote}|\\\\\\[^${quote}\\${line}]|\\[^${quote}\\${line}]|\\\\(?!\\))|(?:\\\\\\\\)+(?!\\)`;
/** Not a quoted value whose closing quote opens the next key of the JSON around the URL
 * (`?code=","password":…`): only JSON punctuation lies between its quotes, and a key and `:` or
 * `=` follow. */
const notJsonBoundary = (quote: string) =>
  String.raw`(?![\s,:{}[\]]*${quote}[a-zA-Z0-9_.$-]*\\?["']\s*[:=])`;
/** A value between backslash-escaped quotes (JSON inside a string) in a URL, whole, when its
 * closing quote ends the URL or its query value: whitespace, the string's own quote, `&`, `#` or
 * the end follows. `openEscapedValue` is one whose closing quote is missing, to where its escapes
 * end. */
const urlEscapedValue = (quote: string) =>
  String.raw`\\${quote}(?:${escapedUnit(quote, String.raw`<>${"`"}\r\n`)})*(?:\\\\\\\\)*\\${quote}(?=[\s"&#]|$)`;
const openEscapedValue = (quote: string) => String.raw`\\${quote}(?:${escapedUnit(quote)})*`;
/** One piece of a URL after its `://`, which runs to whitespace, a quote, `<>` or a
 * backslash-escaped quote: a run of other characters; a quoted value right after `=`
 * (`?token="…"`), to its closing quote unless that quote opens the next key of the JSON around it;
 * one between backslash-escaped quotes (`?token=\"…\"`) that ends the URL or its query value; one
 * whose quote does not close on its line, to the end of the line whatever it holds; a backslash
 * that opens no escaped quote; or a quote after `=` that opens no value. `scrubTextUrl` replaces
 * the quoted values. Pieces are read one at a time, not by one repeated pattern, so no number of
 * pieces can exhaust a regular expression engine's backtracking stack. */
const urlPiece = new RegExp(
  String.raw`[^\s"'<>${"`"}\\]+|(?<==)(?:"${notJsonBoundary('"')}[^"<>${"`"}\r\n]*"|'${notJsonBoundary("'")}[^'<>${"`"}\r\n]*'|${urlEscapedValue('"')}|${urlEscapedValue("'")}|(?:"[^"\r\n]*|'[^'\r\n]*)(?=[\r\n]|$)|${openEscapedValue('"')}\\*(?=[\r\n]|$)|${openEscapedValue("'")}\\*(?=[\r\n]|$))|\\(?!["'])|(?<==)["']`,
  "y",
);
/** Where the URL whose `://` is at `index` ends: `index + 3` when nothing after it is one. */
function urlEnd(text: string, index: number): number {
  let end = index + 3;
  urlPiece.lastIndex = end;
  while (urlPiece.test(text)) end = urlPiece.lastIndex;
  return end;
}
const isSchemeLetter = (code: number) => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
/** `a-z`, `0-9`, `+`, `.` and `-`, case-insensitively. */
const isSchemeCharacter = (code: number) =>
  isSchemeLetter(code) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x2b ||
  code === 0x2e ||
  code === 0x2d;

/** A URL `scrubTextUrls` replaced: where it starts and ends in the text, and how much longer its
 * replacement is. */
type UrlChange = [start: number, end: number, growth: number];

/** Scrubs each URL in free text. Each `://` is found by search and its scheme read back from it:
 * up to 64 scheme characters, starting at a letter, so a longer run before `://` still leaves a
 * URL to scrub and a long run such as `a.a.a…` costs one pass. A URL that runs to the end of a
 * `cut` text may have lost its `@` or `?` there, so it is replaced whole. Each URL it replaces is
 * added to `changes`, and where each URL it does not replace whole lies in the scrubbed text to
 * `kept`. One replaced whole because a span of `closing`, or the userinfo in `nested` of a URL
 * nested in it, lies in its host or path is added to `whole`: where its `[redacted]` lies in the
 * scrubbed text, and the URL as it would have been rewritten. A query name overlapping a span of
 * `hidden` is replaced. Each list of spans is sorted by start. */
function scrubTextUrls(
  text: string,
  state: ScrubState,
  cut = false,
  changes: UrlChange[] = [],
  kept: Span[] = [],
  closing: Span[] = [],
  whole: Array<[at: number, rewritten: string]> = [],
  nested: Span[] = [],
  hidden: Span[] = [],
): string {
  // The furthest any closing span starting at or before each one reaches.
  const reach: number[] = [];
  for (const [, end] of closing) reach.push(Math.max(end, reach.at(-1) ?? 0));
  const hiddenReach: number[] = [];
  for (const [, end] of hidden) hiddenReach.push(Math.max(end, hiddenReach.at(-1) ?? 0));
  let result = "";
  let copied = 0;
  for (let index = text.indexOf("://"); index !== -1; index = text.indexOf("://", index + 1)) {
    if (index < copied) continue;
    let start = index;
    while (start > copied && index - start < 64 && isSchemeCharacter(text.charCodeAt(start - 1)))
      start--;
    while (start < index && !isSchemeLetter(text.charCodeAt(start))) start++;
    if (start === index) continue;
    const end = urlEnd(text, index);
    // A scheme at the end of a cut text may have lost its URL there, so it is replaced whole too.
    if (end === index + 3 && !(cut && end === text.length)) continue;
    const url = text.slice(start, end);
    let scrubbed =
      cut && end === text.length
        ? REDACTED
        : scrubTextUrl(url, state, (from, to) =>
            reaches(hidden, hiddenReach, start + from, start + to),
          );
    // A URL rewritten around a pair or scheme credential before its query, where the rewrite can
    // take the key or scheme word apart from the value, is replaced whole instead, as is one
    // around what the text read on its own hid there, which the rewrite keeps: its host and path
    // are kept. The URL's own userinfo, after its `://` and any `/` or `\`, is not such a span.
    if (scrubbed !== url && scrubbed !== REDACTED) {
      const before = /[?#]/.exec(url);
      const to = before ? start + before.index : end;
      let authority = index + 3;
      while (authority < end && (text[authority] === "/" || text[authority] === "\\")) authority++;
      if (reaches(closing, reach, index + 3, to) || startsBetween(nested, authority + 1, to)) {
        whole.push([result.length + start - copied, scrubbed]);
        scrubbed = REDACTED;
      }
    }
    if (scrubbed !== url) changes.push([start, end, scrubbed.length - url.length]);
    result += text.slice(copied, start);
    if (scrubbed !== REDACTED) kept.push([result.length, result.length + scrubbed.length]);
    result += scrubbed;
    copied = end;
  }
  return result + text.slice(copied);
}
/** Whether a span of `spans` (sorted by start) starts at `from` or after it and before `to`. */
function startsBetween(spans: Span[], from: number, to: number): boolean {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (spans[middle]![0] < from) low = middle + 1;
    else high = middle;
  }
  return low < spans.length && spans[low]![0] < to;
}
/** Whether a span of `spans` (sorted by start, `reach` their running furthest end) overlaps
 * `from` to `to`. */
function reaches(spans: Span[], reach: number[], from: number, to: number): boolean {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (spans[middle]![0] < to) low = middle + 1;
    else high = middle;
  }
  return low > 0 && reach[low - 1]! > from;
}
/** Schemes WHATWG parses as hierarchical, which both SDKs serialize alike. */
const specialScheme = /^(?:https?|wss?|ftp):/i;
/** The quoted values of a URL's text, as `urlPiece` reads them, replaced before the URL is parsed,
 * so an `&` or `=` inside one cannot make the rest of it a query name. One whose quote does not
 * close before the URL's end, and, before its first `#`, one between backslash-escaped quotes,
 * which is never part of a URL in the text around it, are replaced wherever they are; any other
 * only in the query, since one in the host or path can hold the `?` that starts the query or make
 * the URL unparseable. */
const urlOpenValue = /(?<==)(?:"[^"\r\n]*|'[^'\r\n]*)$/;
const urlEscapedValues = new RegExp(
  String.raw`(?<==)(?:(${urlEscapedValue('"')}|${urlEscapedValue("'")})|${openEscapedValue('"')}\\*$|${openEscapedValue("'")}\\*$)`,
  "g",
);
const urlQueryValue = new RegExp(
  String.raw`(?<==)(?:"[^"<>${"`"}\r\n]*"|'[^'<>${"`"}\r\n]*'|\\?["'][^\r\n]*$)`,
  "g",
);
/** Each query name: from the query's `?` or an `&` to its `=`, not from a `?` inside a value. */
const queryName = /(?<=^\?|&)[^=&#]+/g;
/** A scheme word before an escape, which may be of any space (`%20`, `%0B`, `%C2%A0`, `\t`,
 * `\\t`, `\u0020`), or `+`, a form's space, as in `&Bearer%20…` or `&amp;Basic%2B…`; not before
 * an escaped bracket, as in an array's name (`token%5B%5D`). */
const escapedScheme = /(?<![a-z0-9])(?:bearer|basic|token)(?:%(?!5b|5d)|\\|\+)/i;
/** Whether a query name, which would be exported as a name, the text rules never reading it, holds
 * a credential: a `:` (another URL, `?mongodb://u:…@…`, or a pair, `&token:…`), a scheme word
 * before an escape, or a pair or scheme credential the text rules find once `%3A` and
 * `%3D` are read as `:` and `=` (`&auth.token%20…`, `&Authorization%3ABearer%20…`). The URL keeps
 * its extent, so its later values are replaced as ever. */
function isCredentialName(name: string): boolean {
  if (name.includes(":") || escapedScheme.test(name)) return true;
  // A pair needs a `:` or `=`, which a name holds only escaped, and a scheme credential its word,
  // so most names are never read.
  const separated = name.includes("%") ? name.replace(/%3a/gi, ":").replace(/%3d/gi, "=") : name;
  return (
    (separated !== name && pairSpans(separated).length > 0) ||
    (schemeWord.test(name) && authorizationSpans(name).length > 0)
  );
}
const schemeWord = /bearer|basic|token/i;
/** What any name `isCredentialName` holds has: a `:`, `%3A`, `%3D` or a scheme word. */
const credentialNameMark = /:|%3[ad]|bearer|basic|token/i;
/** A replacement: where it starts and its length in the text after it, and how much longer it
 * made the text. */
type Edit = [start: number, length: number, growth: number];
/** Maps a position in a text after `edits` (in order) back to the text before them. Positions must
 * be asked in order, so each edit is passed once. */
function positionBefore(edits: Edit[]): (at: number) => number {
  let next = 0;
  let growth = 0;
  return (at) => {
    for (; next < edits.length && edits[next]![0] + edits[next]![1] <= at; next++)
      growth += edits[next]![2];
    return at - growth;
  };
}
/** A URL in free text, its quoted values replaced. One with another scheme, which runtimes parse
 * differently, is replaced whole when it could carry userinfo, a query or a fragment. A query name
 * that holds a credential, or where `hides` says the text around the URL, read as it was before
 * escaped quotes were, hides something, is replaced. */
function scrubTextUrl(
  url: string,
  state: ScrubState,
  hides: (from: number, to: number) => boolean = () => false,
): string {
  if (!specialScheme.test(url)) return /[@?#]/.test(url) ? REDACTED : url;
  // The first `#` starts the fragment, which is dropped, even inside a quoted value, as the URL
  // parser reads the text; other values are replaced only before it. A closed value between
  // escaped quotes that holds the first `?`, which starts the query as the parser reads it, keeps
  // that `?`, so what follows the value stays in the query.
  const whole = url.replace(urlOpenValue, REDACTED);
  const hash = whole.indexOf("#");
  const fragment = hash === -1 ? "" : whole.slice(hash);
  const head = hash === -1 ? whole : whole.slice(0, hash);
  const question = head.indexOf("?");
  const escaped: Edit[] = [];
  let grown = 0;
  const opened = head.replace(
    urlEscapedValues,
    (value: string, closed: string | undefined, at: number) => {
      const replaced =
        closed !== undefined && at < question && question < at + value.length
          ? `${REDACTED}?${REDACTED}`
          : REDACTED;
      escaped.push([at + grown, replaced.length, replaced.length - value.length]);
      grown += replaced.length - value.length;
      return replaced;
    },
  );
  const query = opened.indexOf("?");
  if (query === -1) return scrubUrl(opened + fragment, state);
  const quoted: Edit[] = [];
  grown = 0;
  const valued = opened.slice(query).replace(urlQueryValue, (value: string, at: number) => {
    quoted.push([query + at + grown, REDACTED.length, REDACTED.length - value.length]);
    grown += REDACTED.length - value.length;
    return REDACTED;
  });
  // A name can hold a credential only where the query holds a `:`, `%3A`, `%3D` or a scheme word,
  // and overlap what `hides` covers only where that covers any of the URL, so most queries' names
  // are not read one by one.
  const overlaps = hides(0, url.length);
  if (!overlaps && !credentialNameMark.test(valued))
    return scrubUrl(opened.slice(0, query) + valued + fragment, state);
  const beforeQuoted = positionBefore(quoted);
  const beforeEscaped = positionBefore(escaped);
  const named = valued.replace(queryName, (name: string, at: number) => {
    if (isCredentialName(name)) return REDACTED;
    if (!overlaps) return name;
    const from = beforeEscaped(beforeQuoted(query + at));
    return hides(from, from + name.length) ? REDACTED : name;
  });
  return scrubUrl(opened.slice(0, query) + named + fragment, state);
}
/** Where a word starts: after a character that is not a word character, or after a JSON escape
 * (`\n`, `\t`, `\u0022`) or `%` escape, which ends in one. */
const wordStart = String.raw`(?:(?<![a-z0-9_])|(?<=\\[bfnrt])|(?<=\\u[0-9a-f]{4})|(?<=%[0-9a-f]{2}))`;
/** Hue's API, MCP, world, attempt, simulation, setup, install, invocation, OAuth and other
 * tokens, and OpenAI and Anthropic (`sk-`), Stripe, Slack, Google OAuth, GitHub and GitLab ones. */
const tokenPrefix = String.raw`(?:hue_(?:sk|mcp|world|attempt|sim|setup|install|inv|at|rt|oauth|ss|vt)_|sk-|[rs]k_(?:live|test)_|xox[abcdeoprs]-|xapp-|ya29\.|gocspx-|gh[opsur]_|github_pat_|glpat-)`;
/** A credential its own prefix identifies wherever a word starts, `%` escapes included. At the end
 * of a cut text, any length of it is a credential, since the rest may have been cut. The
 * lookahead for a first letter, here and before `bearer`, lets a search skip other characters
 * before testing a word start. */
const prefixedToken = new RegExp(
  `(?=[ghrsxy])${wordStart}${tokenPrefix}[a-z0-9_.~+/=%-]{8,}`,
  "gi",
);
const cutPrefixedToken = new RegExp(
  `(?=[ghrsxy])${wordStart}${tokenPrefix}(?:[a-z0-9_.~+/=%-]{8,}|[a-z0-9_.~+/=%-]*$)`,
  "gi",
);
/** An authorization scheme followed by its credential, as in an `Authorization` header, up to
 * whitespace, a quote, a delimiter or a backslash. The space between them may be escaped (`%20`,
 * `\t`), and then an escaped space also ends the credential, which keeps a run of them linear.
 * The credential cannot start with `=` or `:`, so `token = value` and `Token : value` are left to
 * the key-value rule. */
const credentialStart = String.raw`[^\s"'${"`"}<>=:,;(){}[\]\\]`;
const credentialRest = String.raw`[^\s"'${"`"}<>,;(){}[\]\\]`;
const authorizationValue = new RegExp(
  String.raw`(?=[bt])${wordStart}(bearer|basic|token)(?:(\s+)${credentialStart}${credentialRest}*|((?:\s|%20|%09|\\[nrt]|\\u0020)+)(?!%20|%09)${credentialStart}(?:(?!%20|%09)${credentialRest})*)`,
  "gi",
);
/** The key and separator of a `key=value`, `key: value` or `key => value` pair, the key optionally
 * quoted, with a backslash-escaped quote too (JSON inside a string). A key starts where no key
 * character precedes it, so each word is tried once and a long run stays linear. Only a key whose
 * last letter a credential key's can be (`token`, `apiKey`, `headers`, `basic` …) is read. The
 * value is not consumed, so a pair inside another pair's value (`error: token=…`) is found. */
const pairKey = /(\\?["']|)(?<![a-z0-9_-])([a-z0-9_-]*[cdlnrsty][-_]*)\1(\s*(?:=>|[:=])\s*)/gi;
/** A quoted value to its closing quote on the same line, spaces and escaped quotes included, or
 * one between backslash-escaped quotes, double or single. */
const quotedValue = new RegExp(
  String.raw`"(?:[^"\\\r\n]|\\[^\r\n])+"|'(?:[^'\\\r\n]|\\[^\r\n])+'|\\"(?:${escapedUnit('"')})+(?:\\\\\\\\)*\\"|\\'(?:${escapedUnit("'")})+(?:\\\\\\\\)*\\'`,
  "y",
);
/** A quoted value whose quote does not close on its line, as when the text was cut inside it:
 * the value runs to the end of the line, or one between backslash-escaped quotes to the quote that
 * ends the string holding it. */
const openQuotedValue = new RegExp(
  String.raw`(?:"(?:[^"\\\r\n]|\\[^\r\n])+|'(?:[^'\\\r\n]|\\[^\r\n])+)\\?(?=[\r\n]|$)|\\"(?:${escapedUnit('"')})+\\*(?=["\r\n]|$)|\\'(?:${escapedUnit("'")})+\\*(?=['\r\n]|$)`,
  "y",
);
/** What a `[…]` or `{…}` value's brackets are counted between: a bracket, a string (double or
 * single quotes), which runs to the end of the text when it does not close, one between
 * backslash-escaped quotes, which ends where its escapes do, or another escaped character. */
const bracketToken = new RegExp(
  String.raw`[[\]{}]|"(?:[^"\\]|\\[\s\S])*"?|'(?:[^'\\]|\\[\s\S])*'?|\\"(?:${escapedUnit('"', "")})*(?:(?:\\\\\\\\)*\\")?|\\'(?:${escapedUnit("'", "")})*(?:(?:\\\\\\\\)*\\')?|\\[\s\S]`,
  "g",
);
/** An unquoted value, or one whose quote does not close on its line, up to whitespace, a quote or
 * a delimiter; a value already replaced, or a scheme whose credential was, is left alone. */
const bareValue =
  /(\\?["']?)(?!(?:\[redacted\]|%5Bredacted%5D)(?![^\s"',;&})\]\\])|(?:bearer|basic|token)\s)(?:\[redacted\](?=[^\s"',;&})\]\\]))?[^\s"',;&})\]]+/iy;
/** An `Authorization` header's unquoted value: its scheme and the credential after it (`Bot …`,
 * `OAuth1 …`), or a lone credential. One already replaced is left alone. */
const authorizationBare =
  /(\\?["']?)(?!(?:\[redacted\]|%5Bredacted%5D)(?![^\s"',;})\]\\]))((?:\[redacted\](?=[^\s"',;})\]\\]))?[^\s"',;})\]]+)(?:[ \t]+(?:\[redacted\]|[^\s"',;})\]]+))?/y;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}
/** A key naming a credential in free text: a tool definition's credential keys, any header ending
 * in `Authorization`, and `Bearer` and `Basic`. */
function isTextCredentialKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    isCredentialKey(key) ||
    normalized.endsWith("authorization") ||
    normalized === "bearer" ||
    normalized === "basic"
  );
}

/** `API key: …`: a credential named in two words, `key` right after `API`. */
const apiBefore = /(?:^|[^a-z0-9_]|\\[bfnrt]|\\u[0-9a-f]{4}|%[0-9a-f]{2})api[ \t]+$/i;
function isApiKeyPhrase(text: string, keyStart: number, key: string): boolean {
  return (
    key.toLowerCase() === "key" && apiBefore.test(text.slice(Math.max(0, keyStart - 16), keyStart))
  );
}

/** A run of text to replace with `[redacted]`: its start and end offsets. */
type Span = [start: number, end: number];

/** A key that a JSON or `%` escape before it runs into (`\nheaders`, `%20credentials`), without
 * the escape's characters; `undefined` when no escape precedes it. */
function unescapedKey(text: string, keyStart: number, key: string): string | undefined {
  const escape =
    text[keyStart - 1] === "\\"
      ? /^(?:[bfnrt]|u[0-9a-f]{4})/i.exec(key)
      : text[keyStart - 1] === "%"
        ? /^[0-9a-f]{2}/i.exec(key)
        : null;
  return escape ? key.slice(escape[0].length) : undefined;
}

/** Where a `[…]` or `{…}` value that opens at `start` ends: after the bracket that closes it,
 * a closing bracket of another kind and brackets inside strings being part of the value, or at the
 * end of the text when it does not close. */
function bracketEnd(text: string, start: number): number {
  const closers: string[] = [];
  bracketToken.lastIndex = start;
  for (let token = bracketToken.exec(text); token; token = bracketToken.exec(text)) {
    if (token[0] === "[") closers.push("]");
    else if (token[0] === "{") closers.push("}");
    else if (token[0] === closers.at(-1)) {
      closers.pop();
      if (!closers.length) return bracketToken.lastIndex;
    }
  }
  return text.length;
}

/** Whether a quote, or a backslash-escaped quote, opens at `index`. */
function opensQuote(text: string, index: number): boolean {
  const character = text[index];
  return (
    character === '"' ||
    character === "'" ||
    text.startsWith('\\"', index) ||
    text.startsWith("\\'", index)
  );
}

/** The value of each pair whose key names a credential, without its quotes. A pair inside an
 * earlier pair's value is kept when its value runs past that value. */
function pairSpans(text: string): Span[] {
  const spans: Span[] = [];
  let covered = 0;
  // The last `Authorization` value read: where it starts, where its first word ends and where it
  // ends. A value starting inside that first word ends where it does, so each run is read once.
  let authorization: { from: number; firstEnd: number; end: number } | undefined;
  // Where the last `[…]` or `{…}` value ends. One opening inside it closes inside it.
  let bracketed = 0;
  for (const match of text.matchAll(pairKey)) {
    const start = match.index + match[0].length;
    const key = match[2]!;
    const keyStart = match.index + match[1]!.length;
    const unescaped = unescapedKey(text, keyStart, key);
    if (
      !(
        isTextCredentialKey(key) ||
        isApiKeyPhrase(text, keyStart, key) ||
        (unescaped !== undefined && isTextCredentialKey(unescaped))
      )
    )
      continue;
    const nested = start < covered;
    const isAuthorization = normalizedKey(key).endsWith("authorization");
    const bracket =
      (text[start] === "[" || text[start] === "{") && !text.startsWith("[redacted]", start);
    // A value inside an earlier value ends where that value's run or quote ends, so it can run
    // past it only by opening a quote (which may be the one that closes the earlier value) or a
    // bracket outside an earlier bracket or, for `Authorization`, by the word after its scheme.
    if (nested && (bracket ? start < bracketed : !isAuthorization && !opensQuote(text, start)))
      continue;
    quotedValue.lastIndex = start;
    const quoted = quotedValue.exec(text);
    openQuotedValue.lastIndex = start;
    const openQuoted = quoted ? null : openQuotedValue.exec(text);
    let open: number;
    let end: number;
    if (quoted) {
      open = quoted[0].startsWith("\\") ? 2 : 1;
      end = start + quoted[0].length;
    } else if (openQuoted) {
      open = openQuoted[0].startsWith("\\") ? 2 : 1;
      end = start + openQuoted[0].length;
    } else if (bracket) {
      open = 0;
      end = bracketEnd(text, start);
      bracketed = end;
    } else if (isAuthorization) {
      if (
        authorization &&
        start > authorization.from &&
        start < authorization.firstEnd &&
        !opensQuote(text, start) &&
        !text.startsWith("[redacted]", start) &&
        !text.startsWith("%5Bredacted%5D", start)
      ) {
        open = 0;
        end = authorization.end;
      } else {
        authorizationBare.lastIndex = start;
        const value = authorizationBare.exec(text);
        if (!value) continue;
        open = value[1]!.length;
        end = start + value[0].length;
        authorization = { from: start, firstEnd: start + open + value[2]!.length, end };
      }
    } else {
      bareValue.lastIndex = start;
      const value = bareValue.exec(text);
      if (!value) continue;
      open = value[1]!.length;
      end = start + value[0].length;
    }
    if (end <= covered) continue;
    spans.push([start + open, end - (quoted ? open : 0)]);
    covered = end;
  }
  return spans;
}

/** The credential after each authorization scheme. A scheme word can end an earlier credential
 * (`…~bearer SECRET`) or start inside its escaped separator (`Bearer\token SECRET`, `\t` being the
 * separator), so the search resumes after each scheme word, reading its credential at most once
 * more. */
function authorizationSpans(text: string): Span[] {
  const spans: Span[] = [];
  authorizationValue.lastIndex = 0;
  for (let match = authorizationValue.exec(text); match; match = authorizationValue.exec(text)) {
    const credential = match.index + match[1]!.length + (match[2] ?? match[3])!.length;
    spans.push([credential, match.index + match[0].length]);
    authorizationValue.lastIndex = match.index + match[1]!.length;
  }
  return spans;
}

/** Each match of a global pattern. */
function matchSpans(text: string, pattern: RegExp): Span[] {
  return [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}

/** Replaces the union of the spans with `[redacted]`, each run of overlapping or touching spans
 * once. */
function redactSpans(text: string, spans: Span[]): string {
  spans.sort(([a, b], [c, d]) => a - c || b - d);
  let result = "";
  let copied = 0;
  let run: Span | undefined;
  const flush = () => {
    if (!run) return;
    result += `${text.slice(copied, run[0])}${REDACTED}`;
    copied = run[1];
  };
  for (const [start, end] of spans) {
    if (run && start <= run[1]) run[1] = Math.max(run[1], end);
    else {
      flush();
      run = [start, end];
    }
  }
  flush();
  return result + text.slice(copied);
}

/**
 * Removes credentials from free text a provider returned, such as an MCP call's error message,
 * with the rules tool definitions use, extended for text: each `http`, `https`, `ws`, `wss` or
 * `ftp` URL loses its userinfo and fragment and every query value becomes `[redacted]`, as a
 * `url` field does (an unparseable one becomes `[redacted]`), and a URL with any other scheme
 * becomes `[redacted]` when it has an `@`, `?` or `#`; a token with a known credential prefix
 * (`hue_sk_`, `sk-`, `xoxb-`, `ya29.` and others), the credential after an authorization scheme
 * (`Bearer`, `Basic`, `Token`), the whole value of an `Authorization` header, and the value of a
 * `key=value`, `key: value` or `key => value` pair whose key names a credential (quoted,
 * escaped-quoted, bare, or a whole `[…]` or `{…}`) become `[redacted]`. A JSON or `%` escape
 * (`\n`, `\u0022`, `%20`) ends a word as a space does. A quote that does not close on its line
 * runs to the end of the line, and a URL's quoted query value is replaced whole. `cut` says the
 * text was cut from a longer one, so a URL, scheme or prefixed token that runs to its end is
 * replaced whole. Only the first 16,384 code points are read: a longer text is cut there, and `…`
 * marks it.
 */
export function scrubCredentialText(text: string, cut = false): string {
  if (text.length > MAX_SCRUBBED_TEXT) {
    let kept = "";
    let seen = 0;
    for (const character of text) {
      if (seen++ === MAX_SCRUBBED_TEXT) return `${scrubCredentialTextUnbounded(kept, true)}…`;
      kept += character;
    }
  }
  return scrubCredentialTextUnbounded(text, cut);
}

/** The most of a text `scrubCredentialText` reads, in code points, as of a provider's error text:
 * a longer one is cut there and `…` marks the cut, so no caller hands a regular expression engine
 * a text long enough to exhaust it. */
const MAX_SCRUBBED_TEXT = 16_384;

/** `scrubCredentialText` without its bound on the text's length, for tests that time long texts;
 * callers use `scrubCredentialText`. */
export function scrubCredentialTextUnbounded(text: string, cut = false): string {
  const changes: UrlChange[] = [];
  const kept: Span[] = [];
  // The text's pairs and schemes before its URLs are replaced: a URL can take in a key or scheme
  // whose value follows it (`…&password=\"…`), and one rewritten around a credential is replaced
  // whole.
  const credentials = text.includes("://")
    ? [...pairSpans(text), ...authorizationSpans(text)].sort(([a], [b]) => a - b)
    : [];
  // What the text hides with its URLs read as they were before escaped quotes were: a URL read
  // now can end sooner or later, and neither may export what that reading hid. A query name never
  // overlaps a query value or fragment that reading hid.
  const plain = text.includes("://")
    ? plainUrlSpans(text)
    : { hidden: [], userinfo: [], values: [] };
  const closing = [...credentials, ...plain.hidden].sort(([a], [b]) => a - b);
  const whole: Array<[number, string]> = [];
  const scrubbed = scrubTextUrls(
    text,
    { changed: false },
    cut,
    changes,
    kept,
    closing,
    whole,
    plain.userinfo,
    [...closing, ...plain.userinfo].sort(([a], [b]) => a - b),
  );
  const net = [...plain.hidden, ...plain.userinfo, ...plain.values].sort(([a], [b]) => a - b);
  // Every rule reads the same text and their matches are replaced together, so no rule's
  // replacement can hide text another rule would have matched. The pairs and schemes of the text
  // with each URL replaced whole rewritten instead are read too, so what a value that runs out of
  // such a URL reaches is replaced as it was when the URL was rewritten.
  return redactSpans(scrubbed, [
    ...pairSpans(scrubbed),
    ...matchSpans(scrubbed, cut ? cutPrefixedToken : prefixedToken),
    ...authorizationSpans(scrubbed),
    ...nestedUserinfoSpans(scrubbed, kept),
    ...(changes.length || net.length
      ? spansBesideUrls([...credentials, ...outsideUrls(text, net, changes)], changes)
      : []),
    ...(whole.length ? rewrittenSpans(scrubbed, whole) : []),
    ...(cut ? cutSchemeSpans(scrubbed) : []),
  ]);
}

/** Where a cut text ends inside a scheme or its `://`, the rest of the URL cut off: the scheme
 * characters it ends in, read back as a scheme is, with a `:` or `:/` after them. */
function cutSchemeSpans(text: string): Span[] {
  const index = text.length - (text.endsWith(":/") ? 2 : text.endsWith(":") ? 1 : 0);
  let start = index;
  while (start > 0 && index - start < 64 && isSchemeCharacter(text.charCodeAt(start - 1))) start--;
  while (start < index && !isSchemeLetter(text.charCodeAt(start))) start++;
  return start < index ? [[start, text.length]] : [];
}

/** One piece of a URL as read before escaped quotes were: a run of characters that are not
 * whitespace, a quote or `<>`, a closed quoted value right after `=`, or a quote after `=`. */
const plainUrlPiece = /[^\s"'<>`]+|(?<==)"[^"<>`\r\n]*"|(?<==)'[^'<>`\r\n]*'|(?<==)["']/y;

/** What the text hides with each URL read as before escaped quotes were, where it lies in the
 * text, each list sorted by start. `hidden` is all of a URL with another scheme holding `@`, `?`
 * or `#`, or of one the parser refuses, and each pair or scheme credential of the text with those
 * URLs replaced, one starting or ending in a URL starting or ending with it. `userinfo` is each
 * other URL's userinfo, after any `/` or `\` that follow its `://`, as the parser skips them, and
 * `values` its query values and fragment. */
function plainUrlSpans(text: string): { hidden: Span[]; userinfo: Span[]; values: Span[] } {
  const spans: Span[] = [];
  const userinfo: Span[] = [];
  const values: Span[] = [];
  const changes: UrlChange[] = [];
  let scrubbed = "";
  let copied = 0;
  for (let index = text.indexOf("://"); index !== -1; index = text.indexOf("://", index + 1)) {
    if (index < copied) continue;
    let start = index;
    while (start > copied && index - start < 64 && isSchemeCharacter(text.charCodeAt(start - 1)))
      start--;
    while (start < index && !isSchemeLetter(text.charCodeAt(start))) start++;
    if (start === index) continue;
    let end = index + 3;
    plainUrlPiece.lastIndex = end;
    while (plainUrlPiece.test(text)) end = plainUrlPiece.lastIndex;
    if (end === index + 3) continue;
    const url = text.slice(start, end);
    const replaced = specialScheme.test(url)
      ? scrubUrl(url, { changed: false })
      : /[@?#]/.test(url)
        ? REDACTED
        : url;
    scrubbed += text.slice(copied, start) + replaced;
    copied = end;
    if (replaced !== url) changes.push([start, end, replaced.length - url.length]);
    if (replaced === REDACTED) {
      spans.push([start, end]);
      continue;
    }
    let authority = index + 3;
    while (authority < end && (text[authority] === "/" || text[authority] === "\\")) authority++;
    const boundary = text.slice(authority, end).search(/[/\\?#]/);
    const at = text.lastIndexOf("@", (boundary === -1 ? end : authority + boundary) - 1);
    if (at > authority) userinfo.push([authority, at]);
    const hash = url.indexOf("#");
    const tail = hash === -1 ? url.length : hash;
    const question = url.indexOf("?");
    if (question !== -1 && question < tail) {
      let part = start + question + 1;
      for (const piece of url.slice(question + 1, tail).split("&")) {
        const equals = piece.indexOf("=");
        if (equals !== -1 && equals + 1 < piece.length)
          values.push([part + equals + 1, part + piece.length]);
        part += piece.length + 1;
      }
    }
    if (hash !== -1) values.push([start + hash, end]);
  }
  if (!changes.length) return { hidden: spans, userinfo, values };
  scrubbed += text.slice(copied);
  const hidden = [
    ...spans,
    ...spansBeforeUrls([...pairSpans(scrubbed), ...authorizationSpans(scrubbed)], changes),
  ].sort(([a], [b]) => a - b);
  return { hidden, userinfo, values };
}

/** The spans of a text whose URLs `changes` replaced, moved back to where their text lies before:
 * one starting or ending inside a replacement starts or ends with its URL. */
function spansBeforeUrls(spans: Span[], changes: UrlChange[]): Span[] {
  // Where each replacement starts and ends in the text, and how much longer the text is after it.
  const starts: number[] = [];
  const ends: number[] = [];
  const growth: number[] = [];
  let total = 0;
  for (const [start, end, grown] of changes) {
    starts.push(start + total);
    growth.push((total += grown));
    ends.push(end + total);
  }
  // How many replacements start before `position`, or at it when `at` holds.
  const count = (position: number, at: boolean) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! < position || (at && starts[middle] === position)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return spans.map(([start, end]) => {
    const first = count(start, true) - 1;
    const final = count(end, false) - 1;
    const from =
      first === -1 ? start : start < ends[first]! ? changes[first]![0] : start - growth[first]!;
    const to = final === -1 ? end : end <= ends[final]! ? changes[final]![1] : end - growth[final]!;
    return [from, to];
  });
}

/** The parts of `spans` outside every URL `found` replaced (both sorted by start) that hold a
 * letter or digit. */
function outsideUrls(text: string, spans: Span[], found: UrlChange[]): Span[] {
  const parts: Span[] = [];
  let first = 0;
  for (const [from, to] of spans) {
    while (first < found.length && found[first]![1] <= from) first++;
    let cursor = from;
    for (let next = first; next < found.length && found[next]![0] < to; next++) {
      if (found[next]![0] > cursor) parts.push([cursor, found[next]![0]]);
      cursor = Math.max(cursor, found[next]![1]);
    }
    if (cursor < to) parts.push([cursor, to]);
  }
  return parts.filter(([start, end]) => /[a-z0-9]/i.test(text.slice(start, end)));
}

/** The pair and scheme spans of the text with each URL replaced whole rewritten instead, cut to
 * the text outside those URLs and moved to where it is in `text`. */
function rewrittenSpans(text: string, whole: Array<[number, string]>): Span[] {
  let rewritten = "";
  let copied = 0;
  const changes: UrlChange[] = [];
  for (const [at, url] of whole) {
    rewritten += text.slice(copied, at);
    changes.push([rewritten.length, rewritten.length + url.length, REDACTED.length - url.length]);
    rewritten += url;
    copied = at + REDACTED.length;
  }
  rewritten += text.slice(copied);
  return spansBesideUrls([...pairSpans(rewritten), ...authorizationSpans(rewritten)], changes);
}

/** A URL nested in another's path (`…/p&mongodb://u:…@…`): its `://` (or `:\\`) and any more `/`
 * or `\`, then its userinfo to the last `@` before a `/`, `\`, `?`, `#` or whitespace, as a URL's
 * own userinfo is read. */
const nestedUserinfo = /:[/\\]{2}[/\\]*[^\s/\\?#]*@/g;

/** The userinfo of each URL nested in the path of a URL not replaced whole, and the whole of one
 * with another scheme that holds an `@`: the path is kept and the nested URL is not read on its
 * own. */
function nestedUserinfoSpans(text: string, urls: Span[]): Span[] {
  const spans: Span[] = [];
  for (const [start, end] of urls) {
    const url = text.slice(start, end);
    const authority = url.indexOf("://") + 3;
    const boundary = url.slice(authority).search(/[?#]/);
    const pathEnd = boundary === -1 ? url.length : authority + boundary;
    const slash = url.slice(authority, pathEnd).search(/[/\\]/);
    if (slash === -1) continue;
    const pathStart = authority + slash;
    for (const match of url.slice(pathStart, pathEnd).matchAll(nestedUserinfo)) {
      const from = start + pathStart + match.index + 3;
      const to = start + pathStart + match.index + match[0].length - 1;
      if (from < to) spans.push([from, to]);
    }
    // A nested URL with another scheme and an `@` is replaced whole, to the path's end, as it is
    // when read on its own.
    const lastAt = url.lastIndexOf("@", pathEnd - 1);
    for (const match of url.slice(pathStart, pathEnd).matchAll(/:[/\\]{2}/g)) {
      const colon = pathStart + match.index;
      if (lastAt < colon) break;
      let schemeStart = colon;
      while (
        schemeStart > pathStart &&
        colon - schemeStart < 64 &&
        isSchemeCharacter(url.charCodeAt(schemeStart - 1))
      )
        schemeStart--;
      while (schemeStart < colon && !isSchemeLetter(url.charCodeAt(schemeStart))) schemeStart++;
      if (schemeStart === colon || specialScheme.test(`${url.slice(schemeStart, colon)}:`))
        continue;
      spans.push([start + schemeStart, start + pathEnd]);
      break;
    }
  }
  return spans;
}

/** The spans moved to where their text is once the URLs are replaced: one starting inside a
 * replaced URL starts after it, and one ending inside one ends before it. */
function spansBesideUrls(spans: Span[], changes: UrlChange[]): Span[] {
  // How much longer the text is after each replacement.
  const growth: number[] = [];
  let total = 0;
  for (const change of changes) growth.push((total += change[2]));
  // The last replaced URL starting before `position`, or -1.
  const last = (position: number) => {
    let low = 0;
    let high = changes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (changes[middle]![0] < position) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };
  const moved: Span[] = [];
  for (const [start, end] of spans) {
    const first = last(start + 1);
    const from = first === -1 ? start : Math.max(start, changes[first]![1]) + growth[first]!;
    const final = last(end);
    const to =
      final === -1
        ? end
        : end < changes[final]![1]
          ? changes[final]![0] + (growth[final - 1] ?? 0)
          : end + growth[final]!;
    if (from < to) moved.push([from, to]);
  }
  return moved;
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
