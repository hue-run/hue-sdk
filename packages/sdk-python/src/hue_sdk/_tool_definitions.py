"""Hosted-tool credentials removed from exported tool definitions.

Mirrors the TypeScript SDK's ``tool-definitions.ts`` so both export paths replace the same keys.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import re
import unicodedata
from bisect import bisect_left, bisect_right
from collections.abc import Callable, Mapping
from itertools import accumulate
from typing import Any
from urllib.parse import parse_qsl, unquote_to_bytes, urlencode, urlsplit, urlunsplit

from .transport import MAX_REQUEST_BYTES

REDACTED = "[redacted]"

# Compared case-insensitively and ignoring "-" and "_": OpenAI hosted MCP ``authorization`` and
# ``headers``, Anthropic MCP ``authorization_token``, and common API key fields. Provider tool
# schemas are untrusted input, so generic names such as ``token``, ``secret``, and ``password``
# are included too.
_CREDENTIAL_KEYS = frozenset(
    {
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
    }
)
# OpenInference records each tool as ``llm.tools.{index}.tool.json_schema``.
_OPENINFERENCE_TOOL = re.compile(r"llm\.tools\.(\d+)\.tool\.json_schema\Z")
_DEFINITION_KEYS = frozenset({"gen_ai.tool.definitions", "ai.prompt.tools"})
_REQUEST_KEYS = frozenset({"input.value", "output.value", "llm.invocation_parameters"})
_MAX_DEPTH = 256


def _is_credential_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    normalized = key.lower().replace("-", "").replace("_", "")
    return (
        normalized in _CREDENTIAL_KEYS
        or normalized.endswith("token")
        or normalized.endswith("secret")
        or normalized.endswith("password")
        or normalized.endswith("apikey")
        or normalized.endswith("credential")
    )


# JavaScript's ``\s``, spelled out so both SDKs split free text at the same characters.
_JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


# One piece of a value between backslash-escaped quotes (JSON inside a JSON string): a character,
# or a whole run of backslashes with what it escapes. The run's length decides what it is: after
# 4m backslashes, three more and the quote are the inner text's escaped quote, one or three more
# escape another character, two more (or none, after at least four) are escaped backslashes. Each
# run can be read only one way, so a value that does not close is given up in linear time; 4m + 1
# backslashes and the quote close it. ``line`` holds the characters that end a value's line.
def _escaped_unit(quote: str, line: str = r"\r\n") -> str:
    return (
        rf"[^{quote}\\{line}]|(?:\\\\\\\\)*(?:\\\\\\{quote}|\\\\\\[^{quote}\\{line}]"
        rf"|\\[^{quote}\\{line}]|\\\\(?!\\))|(?:\\\\\\\\)+(?!\\)"
    )


_ESCAPED_DOUBLE = _escaped_unit('"')
_ESCAPED_SINGLE = _escaped_unit("'")
_URL_ESCAPED_DOUBLE = _escaped_unit('"', r"<>`\r\n")
_URL_ESCAPED_SINGLE = _escaped_unit("'", r"<>`\r\n")
_BRACKET_ESCAPED_DOUBLE = _escaped_unit('"', "")
_BRACKET_ESCAPED_SINGLE = _escaped_unit("'", "")


# Not a quoted value whose closing quote opens the next key of the JSON around the URL
# (``?code=","password":…``): only JSON punctuation lies between its quotes, and a key and ``:``
# or ``=`` follow.
def _not_json_boundary(quote: str) -> str:
    return rf"(?![{_JS_SPACE},:{{}}\[\]]*{quote}[a-zA-Z0-9_.$-]*\\?[\"'][{_JS_SPACE}]*[:=])"


_NOT_JSON_BOUNDARY_DOUBLE = _not_json_boundary('"')
_NOT_JSON_BOUNDARY_SINGLE = _not_json_boundary("'")
# A value between backslash-escaped quotes (JSON inside a string) in a URL, whole, when its closing
# quote ends the URL or its query value: whitespace, the string's own quote, ``&``, ``#`` or the
# end follows. ``_OPEN_ESCAPED_DOUBLE`` and ``_SINGLE`` are one whose closing quote is missing, to
# where its escapes end.
_URL_BOUNDARY = rf"(?=[{_JS_SPACE}\"&#]|\Z)"
_URL_ESCAPED_VALUE = (
    rf"\\\"(?:{_URL_ESCAPED_DOUBLE})*(?:\\\\\\\\)*\\\"{_URL_BOUNDARY}"
    rf"|\\'(?:{_URL_ESCAPED_SINGLE})*(?:\\\\\\\\)*\\'{_URL_BOUNDARY}"
)
_OPEN_ESCAPED_DOUBLE = rf"\\\"(?:{_ESCAPED_DOUBLE})*"
_OPEN_ESCAPED_SINGLE = rf"\\'(?:{_ESCAPED_SINGLE})*"
# One piece of a URL after its ``://``, which runs to whitespace, a quote, ``<>`` or a
# backslash-escaped quote: a run of other characters; a quoted value right after ``=``
# (``?token="…"``), to its closing quote unless that quote opens the next key of the JSON around
# it; one between backslash-escaped quotes (``?token=\"…\"``) that ends the URL or its query value;
# one whose quote does not close on its line, to the end of the line whatever it holds; a backslash
# that opens no escaped quote; or a quote after ``=`` that opens no value. ``_url_values_replaced``
# replaces the quoted values. Pieces are read one at a time, as in the TypeScript SDK, where one
# repeated pattern could exhaust the regular expression engine's backtracking stack on a URL of
# many pieces.
_URL_PIECE = re.compile(
    rf"[^{_JS_SPACE}\"'<>`\\]+|(?<==)(?:\"{_NOT_JSON_BOUNDARY_DOUBLE}[^\"<>`\r\n]*\""
    rf"|'{_NOT_JSON_BOUNDARY_SINGLE}[^'<>`\r\n]*'|{_URL_ESCAPED_VALUE}"
    r"|(?:\"[^\"\r\n]*|'[^'\r\n]*)(?=[\r\n]|\Z)"
    rf"|{_OPEN_ESCAPED_DOUBLE}\\*(?=[\r\n]|\Z)|{_OPEN_ESCAPED_SINGLE}\\*(?=[\r\n]|\Z))"
    r"|\\(?![\"'])|(?<==)[\"']",
)


def _url_end(text: str, index: int) -> int:
    """Where the URL whose ``://`` is at ``index`` ends: ``index + 3`` when nothing after it is
    one."""
    end = index + 3
    while (piece := _URL_PIECE.match(text, end)) is not None:
        end = piece.end()
    return end


_SCHEME_LETTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
_SCHEME_CHARACTERS = _SCHEME_LETTERS | frozenset("0123456789+.-")
# Schemes WHATWG parses as hierarchical, which both SDKs serialize alike.
_SPECIAL_TEXT_SCHEME = re.compile(r"(?:https?|wss?|ftp):", re.IGNORECASE | re.ASCII)
_URL_PARTS = re.compile(r"[@?#]")
# The quoted values of a URL's text, as ``_URL_PIECE`` reads them, replaced before the URL is
# parsed, so an ``&`` or ``=`` inside one cannot make the rest of it a query name. One whose quote
# does not close before the URL's end, and, before its first ``#``, one between backslash-escaped
# quotes, which is never part of a URL in the text around it, are replaced wherever they are; any
# other only in the query, since one in the host or path can hold the ``?`` that starts the query
# or make the URL unparseable.
_URL_OPEN_VALUE = re.compile(r"(?<==)(?:\"[^\"\r\n]*|'[^'\r\n]*)\Z")
_URL_ESCAPED_VALUES = re.compile(
    rf"(?<==)(?:({_URL_ESCAPED_VALUE})|{_OPEN_ESCAPED_DOUBLE}\\*\Z|{_OPEN_ESCAPED_SINGLE}\\*\Z)"
)
_URL_QUERY_VALUE = re.compile(r"(?<==)(?:\"[^\"<>`\r\n]*\"|'[^'<>`\r\n]*'|\\?[\"'][^\r\n]*\Z)")
# Each query name: from the query's ``?`` or an ``&`` to its ``=``, not from a ``?`` inside a
# value.
_QUERY_NAME = re.compile(r"(?:(?<=\A\?)|(?<=&))[^=&#]+")
# A scheme word, where no letter or digit comes before it or after an escape, before an escape,
# which may be of any space (``%20``, ``%0B``, ``%C2%A0``, ``\t``, ``\\t``, ``\u0020``), or ``+``,
# a form's space, as in ``&Bearer%20…`` or ``&amp;%20Basic%2B…``; not before an escaped bracket, as
# in an array's name (``token%5B%5D``).
_ESCAPED_SCHEME = re.compile(
    r"(?:(?<![a-z0-9])|(?<=%[0-9a-f]{2})|(?<=\\[bfnrt])|(?<=\\u[0-9a-f]{4}))"
    r"(?:bearer|basic|token)(?:%(?!5b|5d)|\\|\+)",
    re.I | re.A,
)
_ESCAPED_COLON = re.compile("%3a", re.IGNORECASE)
_ESCAPED_EQUALS = re.compile("%3d", re.IGNORECASE)
_SCHEME_WORD = re.compile("bearer|basic|token", re.IGNORECASE | re.ASCII)
# What any name ``_is_credential_name`` holds has: a ``:``, ``%3A``, ``%3D`` or a scheme word.
_CREDENTIAL_NAME_MARK = re.compile(":|%3[ad]|bearer|basic|token", re.IGNORECASE | re.ASCII)
# Where a word starts: after a character that is not a word character, or after a JSON escape
# (``\n``, ``\t``, ``\u0022``) or ``%`` escape, which ends in one.
_WORD_START = r"(?:(?<![a-z0-9_])|(?<=\\[bfnrt])|(?<=\\u[0-9a-f]{4})|(?<=%[0-9a-f]{2}))"
# Hue's API, MCP, world, attempt, simulation, setup, install, invocation, OAuth and other tokens,
# and OpenAI and Anthropic (``sk-``), Stripe, Slack, Google OAuth, GitHub and GitLab ones.
_TOKEN_PREFIX = (
    r"(?:hue_(?:sk|mcp|world|attempt|sim|setup|install|inv|at|rt|oauth|ss|vt)_|sk-"
    r"|[rs]k_(?:live|test)_|xox[abcdeoprs]-|xapp-|ya29\.|gocspx-|gh[opsur]_|github_pat_|glpat-)"
)
# A credential its own prefix identifies wherever a word starts, ``%`` escapes included. At the
# end of a cut text, any length of it is a credential, since the rest may have been cut. The
# lookahead for a first letter, here and before ``bearer``, lets a search skip other characters
# before testing a word start.
_PREFIXED_TOKEN = re.compile(
    r"(?=[ghrsxy])" + _WORD_START + _TOKEN_PREFIX + r"[a-z0-9_.~+/=%-]{8,}",
    re.IGNORECASE | re.ASCII,
)
_CUT_PREFIXED_TOKEN = re.compile(
    r"(?=[ghrsxy])" + _WORD_START + _TOKEN_PREFIX + r"(?:[a-z0-9_.~+/=%-]{8,}|[a-z0-9_.~+/=%-]*\Z)",
    re.IGNORECASE | re.ASCII,
)
# An authorization scheme followed by its credential, as in an ``Authorization`` header, up to
# whitespace, a quote, a delimiter or a backslash. The space between them may be escaped (``%20``,
# ``\t``), and then an escaped space also ends the credential, which keeps a run of them linear.
# The credential cannot start with ``=`` or ``:``, so ``token = value`` and ``Token : value`` are
# left to the key-value rule.
_CREDENTIAL_START = rf"[^{_JS_SPACE}\"'`<>=:,;(){{}}\[\]\\]"
_CREDENTIAL_REST = rf"[^{_JS_SPACE}\"'`<>,;(){{}}\[\]\\]"
_AUTHORIZATION_VALUE = re.compile(
    rf"(?=[bt]){_WORD_START}(bearer|basic|token)"
    rf"(?:([{_JS_SPACE}]+){_CREDENTIAL_START}{_CREDENTIAL_REST}*"
    rf"|((?:[{_JS_SPACE}]|%20|%09|\\[nrt]|\\u0020)+)(?!%20|%09){_CREDENTIAL_START}"
    rf"(?:(?!%20|%09){_CREDENTIAL_REST})*)",
    re.IGNORECASE | re.ASCII,
)
# The key and separator of a ``key=value``, ``key: value`` or ``key => value`` pair, the key
# optionally quoted, with a backslash-escaped quote too (JSON inside a string). A key starts where
# no key character precedes it, so each word is tried once and a long run stays linear. Only a key
# whose last letter a credential key's can be (``token``, ``apiKey``, ``headers``, ``basic`` …) is
# read. The value is not consumed, so a pair inside another pair's value (``error: token=…``) is
# found.
_PAIR_KEY = re.compile(
    rf"(\\?[\"']|)(?<![a-z0-9_-])([a-z0-9_-]*[cdlnrsty][-_]*)\1"
    rf"([{_JS_SPACE}]*(?:=>|[:=])[{_JS_SPACE}]*)",
    re.IGNORECASE | re.ASCII,
)


# A quoted value to its closing quote on the same line, spaces and escaped quotes included, or one
# between backslash-escaped quotes, double or single.
_QUOTED_VALUE = re.compile(
    r"\"(?:[^\"\\\r\n]|\\[^\r\n])+\"|'(?:[^'\\\r\n]|\\[^\r\n])+'"
    rf"|\\\"(?:{_ESCAPED_DOUBLE})+(?:\\\\\\\\)*\\\"|\\'(?:{_ESCAPED_SINGLE})+(?:\\\\\\\\)*\\'"
)
# A quoted value whose quote does not close on its line, as when the text was cut inside it: the
# value runs to the end of the line, or one between backslash-escaped quotes to the quote that ends
# the string holding it.
_OPEN_QUOTED_VALUE = re.compile(
    r"(?:\"(?:[^\"\\\r\n]|\\[^\r\n])+|'(?:[^'\\\r\n]|\\[^\r\n])+)\\?(?=[\r\n]|\Z)"
    rf"|\\\"(?:{_ESCAPED_DOUBLE})+\\*(?=[\"\r\n]|\Z)"
    rf"|\\'(?:{_ESCAPED_SINGLE})+\\*(?=['\r\n]|\Z)"
)
# What a ``[…]`` or ``{…}`` value's brackets are counted between: a bracket, a string (double or
# single quotes), which runs to the end of the text when it does not close, one between
# backslash-escaped quotes, which ends where its escapes do, or another escaped character.
_BRACKET_TOKEN = re.compile(
    r"[\[\]{}]|\"(?:[^\"\\]|\\[\s\S])*\"?|'(?:[^'\\]|\\[\s\S])*'?"
    rf"|\\\"(?:{_BRACKET_ESCAPED_DOUBLE})*(?:(?:\\\\\\\\)*\\\")?"
    rf"|\\'(?:{_BRACKET_ESCAPED_SINGLE})*(?:(?:\\\\\\\\)*\\')?|\\[\s\S]"
)
# An unquoted value, or one whose quote does not close on its line, up to whitespace, a quote or
# a delimiter; a value already replaced, or a scheme whose credential was, is left alone.
_BARE_VALUE = re.compile(
    rf"(\\?[\"']?)(?!(?:\[redacted\]|%5Bredacted%5D)(?![^{_JS_SPACE}\"',;&}})\]\\])"
    rf"|(?:bearer|basic|token)[{_JS_SPACE}])"
    rf"(?:\[redacted\](?=[^{_JS_SPACE}\"',;&}})\]\\]))?[^{_JS_SPACE}\"',;&}})\]]+",
    re.IGNORECASE | re.ASCII,
)
# An ``Authorization`` header's unquoted value: its scheme and the credential after it (``Bot …``,
# ``OAuth1 …``), or a lone credential. One already replaced is left alone.
_AUTHORIZATION_BARE = re.compile(
    rf"(\\?[\"']?)(?!(?:\[redacted\]|%5Bredacted%5D)(?![^{_JS_SPACE}\"',;}})\]\\]))"
    rf"((?:\[redacted\](?=[^{_JS_SPACE}\"',;}})\]\\]))?[^{_JS_SPACE}\"',;}})\]]+)"
    rf"(?:[ \t]+(?:\[redacted\]|[^{_JS_SPACE}\"',;}})\]]+))?"
)


def _scrub_text_urls(
    text: str,
    cut: bool = False,
    changes: list[tuple[int, int, int]] | None = None,
    kept: list[tuple[int, int]] | None = None,
    closing: list[tuple[int, int]] | None = None,
    whole: list[tuple[int, str]] | None = None,
    nested: list[tuple[int, int]] | None = None,
    hidden: list[tuple[int, int]] | None = None,
) -> str:
    """Scrub each URL in free text. Each ``://`` is found by search and its scheme read back from
    it: up to 64 scheme characters, starting at a letter, so a longer run before ``://`` still
    leaves a URL to scrub and a long run such as ``a.a.a…`` costs one pass. A URL that runs to the
    end of a ``cut`` text may have lost its ``@`` or ``?`` there, so it is replaced whole. Each URL
    it replaces is added to ``changes``: where it starts and ends, and how much longer its
    replacement is; where each URL it does not replace whole lies in the scrubbed text is added to
    ``kept``. One replaced whole because a span of ``closing`` runs past its ``://`` from before it
    or starts in its host or path (not in its own userinfo), or the userinfo in ``nested`` of a URL
    nested in it starts there, is added to ``whole``: where its ``[redacted]`` lies in the scrubbed
    text, and the URL as it would have been rewritten. A query name overlapping a
    span of ``hidden`` is replaced. Each list of spans is sorted by start."""
    scrub = _Scrub()
    spans = closing or []
    starts = [span[0] for span in spans]
    # The furthest any closing span starting at or before each one reaches.
    reach = list(accumulate((span[1] for span in spans), max))
    nested_starts = [span[0] for span in nested or []]
    hidden_spans = hidden or []
    hidden_starts = [span[0] for span in hidden_spans]
    hidden_reach = list(accumulate((span[1] for span in hidden_spans), max))

    def hides_from(start: int) -> Callable[[int, int], bool]:
        def hides(begin: int, stop: int) -> bool:
            count = bisect_left(hidden_starts, start + stop)
            return bool(count) and hidden_reach[count - 1] > start + begin

        return hides

    # Each URL's scrubbed text, as a text can repeat one many times.
    scrubbed: dict[str, str] = {}
    parts: list[str] = []
    # The length of the parts so far.
    length = 0
    copied = 0
    index = text.find("://")
    while index != -1:
        if index >= copied:
            start = index
            while start > copied and index - start < 64 and text[start - 1] in _SCHEME_CHARACTERS:
                start -= 1
            while start < index and text[start] not in _SCHEME_LETTERS:
                start += 1
            end = _url_end(text, index) if start < index else index + 3
            # A scheme at the end of a cut text may have lost its URL there, so it is replaced
            # whole too.
            if start < index and (end > index + 3 or (cut and end == len(text))):
                url = text[start:end]
                hides = hides_from(start)
                if cut and end == len(text):
                    replaced = REDACTED
                elif not _SPECIAL_TEXT_SCHEME.match(url):
                    replaced = REDACTED if _URL_PARTS.search(url) else url
                elif hides(0, len(url)):
                    # What the query names are replaced for depends on where the URL lies.
                    replaced = scrub.url(_url_values_replaced(url, hides))
                else:
                    replaced = scrubbed.get(url) or scrubbed.setdefault(
                        url, scrub.url(_url_values_replaced(url))
                    )
                # A URL rewritten around a pair or scheme credential before its query, where the
                # rewrite can take the key or scheme word apart from the value, is replaced whole
                # instead, as is one around what the text read on its own hid there, which the
                # rewrite keeps: its host and path are kept. A span starting in the URL's own
                # userinfo, which the rewrite drops, is not such a span
                # (``https://x-access-token:…@github.com/…``).
                if replaced not in (url, REDACTED):
                    boundary = _QUERY_OR_FRAGMENT.search(url)
                    to = end if boundary is None else start + boundary.start()
                    authority, at = _userinfo_span(text, index, end)
                    host = at + 1 if at > authority else index + 3
                    count = bisect_left(starts, index + 3)
                    first = bisect_left(starts, host)
                    nested_first = bisect_left(nested_starts, authority + 1)
                    if (
                        (count and reach[count - 1] > index + 3)
                        or (first < len(starts) and starts[first] < to)
                        or (nested_first < len(nested_starts) and nested_starts[nested_first] < to)
                    ):
                        if whole is not None:
                            whole.append((length + start - copied, replaced))
                        replaced = REDACTED
                if changes is not None and replaced != url:
                    changes.append((start, end, len(replaced) - len(url)))
                before = text[copied:start]
                if kept is not None and replaced != REDACTED:
                    kept.append((length + len(before), length + len(before) + len(replaced)))
                parts.append(before + replaced)
                length += len(before) + len(replaced)
                copied = end
        index = text.find("://", index + 1)
    parts.append(text[copied:])
    return "".join(parts)


def _userinfo_span(text: str, index: int, end: int) -> tuple[int, int]:
    """Where the userinfo of the URL whose ``://`` is at ``index``, ending at ``end``, lies: after
    any ``/`` or ``\\`` that follow ``://``, as the parser skips them, to the last ``@`` before a
    ``/``, ``\\``, ``?`` or ``#``; an empty span at its start when it has no ``@``."""
    authority = index + 3
    while authority < end and text[authority] in "/\\":
        authority += 1
    boundary = _AUTHORITY_END.search(text, authority, end)
    at = text.rfind("@", authority, end if boundary is None else boundary.start())
    return authority, authority if at == -1 else at


def _is_credential_name(name: str) -> bool:
    """Whether a query name, which would be exported as a name, the text rules never reading it,
    holds a credential: a ``:`` (another URL, ``?mongodb://u:…@…``, or a pair, ``&token:…``), a
    scheme word before an escape, or a pair or scheme credential the text rules find
    once ``%3A`` and ``%3D`` are read as ``:`` and ``=`` (``&auth.token%20…``,
    ``&Authorization%3ABearer%20…``). The URL keeps its extent, so its later values are replaced
    as ever."""
    if ":" in name or _ESCAPED_SCHEME.search(name):
        return True
    # A pair needs a ``:`` or ``=``, which a name holds only escaped, and a scheme credential its
    # word, so most names are never read.
    separated = _ESCAPED_EQUALS.sub("=", _ESCAPED_COLON.sub(":", name)) if "%" in name else name
    return (separated != name and bool(_pair_spans(separated))) or (
        _SCHEME_WORD.search(name) is not None and bool(_authorization_spans(name))
    )


def _position_before(edits: list[tuple[int, int, int]]) -> Callable[[int], int]:
    """Maps a position in a text after ``edits`` (in order; each where a replacement starts and its
    length in the text after it, and how much longer it made the text) back to the text before
    them. Positions must be asked in order, so each edit is passed once."""
    following = 0
    growth = 0

    def before(at: int) -> int:
        nonlocal following, growth
        while following < len(edits) and edits[following][0] + edits[following][1] <= at:
            growth += edits[following][2]
            following += 1
        return at - growth

    return before


def _url_values_replaced(url: str, hides: Callable[[int, int], bool] | None = None) -> str:
    """A URL's quoted values replaced: one it ends in or one between backslash-escaped quotes,
    wherever it is, and each other in its query. The first ``#`` starts the fragment, which is
    dropped, even inside a quoted value, as the URL parser reads the text; values other than one
    it ends in are replaced only before it. A closed value between escaped quotes that holds the
    first ``?``, which starts the query as the parser reads it, keeps that ``?``, so what follows
    the value stays in the query. A query name that holds a credential, or where ``hides`` says the
    text around the URL, read as it was before escaped quotes were, hides something, is
    replaced."""
    whole = _URL_OPEN_VALUE.sub(REDACTED, url, count=1)
    hash_at = whole.find("#")
    fragment = "" if hash_at == -1 else whole[hash_at:]
    head = whole if hash_at == -1 else whole[:hash_at]
    question = head.find("?")
    escaped: list[tuple[int, int, int]] = []
    grown = 0

    def escape(value: re.Match[str]) -> str:
        nonlocal grown
        replaced = (
            f"{REDACTED}?{REDACTED}"
            if value.group(1) is not None and value.start() < question < value.end()
            else REDACTED
        )
        escaped.append((value.start() + grown, len(replaced), len(replaced) - len(value[0])))
        grown += len(replaced) - len(value[0])
        return replaced

    opened = _URL_ESCAPED_VALUES.sub(escape, head)
    query = opened.find("?")
    if query == -1:
        return opened + fragment
    quoted: list[tuple[int, int, int]] = []
    grown = 0

    def quote(value: re.Match[str]) -> str:
        nonlocal grown
        quoted.append((query + value.start() + grown, len(REDACTED), len(REDACTED) - len(value[0])))
        grown += len(REDACTED) - len(value[0])
        return REDACTED

    valued = _URL_QUERY_VALUE.sub(quote, opened[query:])
    # A name can hold a credential only where the query holds a ``:``, ``%3A``, ``%3D`` or a scheme
    # word, and ``hides`` is passed only when what it covers overlaps the URL, so most queries'
    # names are not read one by one.
    if hides is None and not _CREDENTIAL_NAME_MARK.search(valued):
        return opened[:query] + valued + fragment
    before_quoted = _position_before(quoted)
    before_escaped = _position_before(escaped)

    def name(match: re.Match[str]) -> str:
        if _is_credential_name(match[0]):
            return REDACTED
        if hides is None:
            return match[0]
        begin = before_escaped(before_quoted(query + match.start()))
        return REDACTED if hides(begin, begin + len(match[0])) else match[0]

    return opened[:query] + _QUERY_NAME.sub(name, valued) + fragment


# ``_BARE_VALUE`` and ``_AUTHORIZATION_BARE`` for a value that starts with a placeholder after
# ``=>``, which is read to its end as any other value is, a ``[redacted]`` it starts with included.
_ARROWED_BARE_VALUE = re.compile(
    rf"(\\?[\"']?)(?:\[redacted\][^{_JS_SPACE}\"',;&}})\]]*|[^{_JS_SPACE}\"',;&}})\]]+)",
    re.IGNORECASE | re.ASCII,
)
_ARROWED_AUTHORIZATION_BARE = re.compile(
    rf"(\\?[\"']?)(\[redacted\][^{_JS_SPACE}\"',;}})\]]*|[^{_JS_SPACE}\"',;}})\]]+)"
    rf"(?:[ \t]+(?:\[redacted\][^{_JS_SPACE}\"',;}})\]]*|[^{_JS_SPACE}\"',;}})\]]+))?",
    re.IGNORECASE | re.ASCII,
)
_PLACEHOLDER_START = re.compile(r"\[redacted\]|%5Bredacted%5D", re.IGNORECASE | re.ASCII)


def _normalized_key(key: str) -> str:
    return key.lower().replace("-", "").replace("_", "")


def _is_text_credential_key(key: str) -> bool:
    """A key naming a credential in free text: a tool definition's credential keys, any header
    ending in ``Authorization``, and ``Bearer`` and ``Basic``."""
    normalized = _normalized_key(key)
    return (
        _is_credential_key(key)
        or normalized.endswith("authorization")
        or normalized in ("bearer", "basic")
    )


# ``API key: …``: a credential named in two words, ``key`` right after ``API``.
_API_BEFORE = re.compile(
    r"(?:^|[^a-z0-9_]|\\[bfnrt]|\\u[0-9a-f]{4}|%[0-9a-f]{2})api[ \t]+\Z", re.IGNORECASE | re.ASCII
)


def _is_api_key_phrase(text: str, key_start: int, key: str) -> bool:
    return (
        len(key) == 3
        and key.lower() == "key"
        and bool(_API_BEFORE.search(text[max(0, key_start - 16) : key_start]))
    )


_KEY_ESCAPE = re.compile(r"[bfnrt]|u[0-9a-f]{4}", re.IGNORECASE | re.ASCII)
_KEY_PERCENT_ESCAPE = re.compile(r"[0-9a-f]{2}", re.IGNORECASE | re.ASCII)


def _unescaped_key(text: str, key_start: int, key: str) -> str | None:
    """A key that a JSON or ``%`` escape before it runs into (``\nheaders``, ``%20credentials``),
    without the escape's characters; ``None`` when no escape precedes it."""
    before = text[key_start - 1 : key_start]
    escape = (
        _KEY_ESCAPE.match(key)
        if before == "\\"
        else _KEY_PERCENT_ESCAPE.match(key)
        if before == "%"
        else None
    )
    return key[escape.end() :] if escape else None


def _bracket_end(text: str, start: int) -> int:
    """Where a ``[…]`` or ``{…}`` value that opens at ``start`` ends: after the bracket that closes
    it, a closing bracket of another kind and brackets inside strings being part of the value, or
    at the end of the text when it does not close."""
    closers: list[str] = []
    for token in _BRACKET_TOKEN.finditer(text, start):
        if token[0] == "[":
            closers.append("]")
        elif token[0] == "{":
            closers.append("}")
        elif closers and token[0] == closers[-1]:
            closers.pop()
            if not closers:
                return token.end()
    return len(text)


def _opens_quote(text: str, index: int) -> bool:
    """Whether a quote, or a backslash-escaped quote, opens at ``index``."""
    return text[index : index + 1] in ('"', "'") or text.startswith(('\\"', "\\'"), index)


def _pair_spans(text: str) -> list[tuple[int, int]]:
    """The value of each pair whose key names a credential, without its quotes. A pair inside an
    earlier pair's value is kept when its value runs past that value."""
    spans: list[tuple[int, int]] = []
    covered = 0
    # The last ``Authorization`` value read: where it starts, where its first word ends and where
    # it ends. A value starting inside that first word ends where it does, so each run is read once.
    authorization: tuple[int, int, int] | None = None
    # Where the last ``[…]`` or ``{…}`` value ends. One opening inside it closes inside it.
    bracketed = 0
    # Whether each key names a credential; a long text repeats its keys.
    credential_keys: dict[str, bool] = {}
    for match in _PAIR_KEY.finditer(text):
        key = match[2]
        credential = credential_keys.get(key)
        if credential is None:
            credential = credential_keys[key] = _is_text_credential_key(key)
        if not credential:
            key_start = match.start(2)
            unescaped = (
                _unescaped_key(text, key_start, key)
                if text[key_start - 1 : key_start] in ("\\", "%")
                else None
            )
            if not (
                (len(key) == 3 and _is_api_key_phrase(text, key_start, key))
                or (unescaped and _is_text_credential_key(unescaped))
            ):
                continue
        start = match.end()
        nested = start < covered
        is_authorization = _normalized_key(key).endswith("authorization")
        bracket = text[start : start + 1] in ("[", "{") and not text.startswith("[redacted]", start)
        # A value inside an earlier value ends where that value's run or quote ends, so it can run
        # past it only by opening a quote (which may be the one that closes the earlier value) or a
        # bracket outside an earlier bracket or, for ``Authorization``, by the word after its
        # scheme.
        if nested and (
            start < bracketed if bracket else not is_authorization and not _opens_quote(text, start)
        ):
            continue
        # 0.11.0 read ``=>`` as ``=`` and the value from the ``>``, whatever followed it, so a
        # placeholder right after ``=>`` is not taken for a value already replaced.
        arrowed = "=>" in match[3] and _PLACEHOLDER_START.match(text, start) is not None
        quoted = _QUOTED_VALUE.match(text, start)
        open_quoted = None if quoted else _OPEN_QUOTED_VALUE.match(text, start)
        if quoted:
            opening = 2 if quoted[0].startswith("\\") else 1
            end = quoted.end()
        elif open_quoted:
            opening = 2 if open_quoted[0].startswith("\\") else 1
            end = open_quoted.end()
        elif bracket:
            opening, end = 0, _bracket_end(text, start)
            bracketed = end
        elif is_authorization:
            if (
                authorization is not None
                and authorization[0] < start < authorization[1]
                and not _opens_quote(text, start)
                and not text.startswith("[redacted]", start)
                and not text.startswith("%5Bredacted%5D", start)
            ):
                opening, end = 0, authorization[2]
            else:
                pattern = _ARROWED_AUTHORIZATION_BARE if arrowed else _AUTHORIZATION_BARE
                value = pattern.match(text, start)
                if value is None:
                    continue
                opening, end = len(value[1]), value.end()
                authorization = (start, value.end(2), end)
        else:
            value = (_ARROWED_BARE_VALUE if arrowed else _BARE_VALUE).match(text, start)
            if value is None:
                continue
            opening, end = len(value[1]), value.end()
        if end <= covered:
            continue
        spans.append((start + opening, end - (opening if quoted else 0)))
        covered = end
    return spans


def _authorization_spans(text: str) -> list[tuple[int, int]]:
    """The credential after each authorization scheme. A scheme word can end an earlier credential
    (``…~bearer SECRET``) or start inside its escaped separator (``Bearer\token SECRET``, ``\t``
    being the separator), so the search resumes after each scheme word, reading its credential at
    most once more."""
    spans: list[tuple[int, int]] = []
    position = 0
    while (match := _AUTHORIZATION_VALUE.search(text, position)) is not None:
        credential = match.start() + len(match[1]) + len(match[2] or match[3])
        spans.append((credential, match.end()))
        position = match.start() + len(match[1])
    return spans


def _redact_spans(text: str, spans: list[tuple[int, int]]) -> str:
    """Replace the union of the spans with ``[redacted]``, each run of overlapping or touching
    spans once."""
    parts: list[str] = []
    copied = 0
    run: list[int] | None = None
    for start, end in sorted(spans):
        if run is not None and start <= run[1]:
            run[1] = max(run[1], end)
            continue
        if run is not None:
            parts.append(text[copied : run[0]] + REDACTED)
            copied = run[1]
        run = [start, end]
    if run is not None:
        parts.append(text[copied : run[0]] + REDACTED)
        copied = run[1]
    parts.append(text[copied:])
    return "".join(parts)


def scrub_credential_text(text: str, cut: bool = False) -> str:
    """Remove credentials from free text a provider returned, such as an MCP error message.

    The rules are the tool definitions', extended for text: each ``http``, ``https``, ``ws``,
    ``wss`` or ``ftp`` URL loses its userinfo and fragment and every query value becomes
    ``[redacted]``, as a ``url`` field does (an unparseable one becomes ``[redacted]``), and a URL
    with any other scheme, which runtimes parse differently, becomes ``[redacted]`` when it has an
    ``@``, ``?`` or ``#``; a token with a known credential prefix (``hue_sk_``, ``sk-``,
    ``xoxb-``, ``ya29.`` and others), the credential after an authorization scheme (``Bearer``,
    ``Basic``, ``Token``), the whole value of an ``Authorization`` header, and the value of a
    ``key=value``, ``key: value`` or ``key => value`` pair whose key names a credential (quoted,
    escaped-quoted, bare, or a whole ``[…]`` or ``{…}``) become ``[redacted]``. A JSON or ``%``
    escape (``\n``, ``\u0022``, ``%20``) ends a word as a space does. A quote that does not close
    on its line runs to the end of the line, and a URL's quoted query value is replaced whole.
    ``cut`` says the text was cut from a longer one, so a URL or prefixed token that runs to its end
    is replaced whole, as is the word of scheme characters it ends in, which may start a URL's
    scheme. Only the first 16,384 code points are read: a longer text is cut there, and ``…``
    marks it. Identical to the TypeScript SDK's ``scrubCredentialText``.
    """
    if len(text) > _MAX_SCRUBBED_TEXT:
        return f"{_scrub_credential_text_unbounded(text[:_MAX_SCRUBBED_TEXT], True)}…"
    return _scrub_credential_text_unbounded(text, cut)


# The most of a text ``scrub_credential_text`` reads, in code points, as of a provider's error
# text: a longer one is cut there and ``…`` marks the cut, so no caller hands a regular expression
# engine a text long enough to exhaust it.
_MAX_SCRUBBED_TEXT = 16_384


def _scrub_credential_text_unbounded(text: str, cut: bool = False) -> str:
    """``scrub_credential_text`` without its bound on the text's length, for tests that time long
    texts; callers use ``scrub_credential_text``."""
    changes: list[tuple[int, int, int]] = []
    kept: list[tuple[int, int]] = []
    # The text's pairs, schemes and prefixed tokens before its URLs are replaced: a URL can take in
    # a key or scheme whose value follows it (``…&password=\"…``), one rewritten around a
    # credential is replaced whole, and the parser can join a token in a host to the letter before
    # it.
    credentials = (
        sorted(
            [
                *_pair_spans(text),
                *_authorization_spans(text),
                *(match.span() for match in _PREFIXED_TOKEN.finditer(text)),
            ]
        )
        if "://" in text
        else []
    )
    # What the text hides with its URLs read as they were before escaped quotes were: a URL read
    # now can end sooner or later, and neither may export what that reading hid. A query name
    # overlaps a query value or fragment that reading hid only in a URL starting inside it, whose
    # host or path it then reaches, so those close a URL but are not checked against names.
    plain, userinfo, values = _plain_url_spans(text) if "://" in text else ([], [], [])
    closing = sorted([*credentials, *plain, *values])
    whole: list[tuple[int, str]] = []
    # A credential starting in a URL's own userinfo, which the rewrite drops with its key, hides
    # neither the names after it nor, below, the text after the URL.
    hidden = sorted([*_outside_userinfo(credentials, userinfo), *plain, *userinfo])
    scrubbed = _scrub_text_urls(text, cut, changes, kept, closing, whole, userinfo, hidden)
    net = sorted([*plain, *userinfo, *values])
    # Every rule reads the same text and their matches are replaced together, so no rule's
    # replacement can hide text another rule would have matched. The pairs and schemes of the text
    # with each URL replaced whole rewritten instead are read too, so what a value that runs out of
    # such a URL reaches is replaced as it was when the URL was rewritten.
    tokens = _CUT_PREFIXED_TOKEN if cut else _PREFIXED_TOKEN
    spans = [
        *_pair_spans(scrubbed),
        *(match.span() for match in tokens.finditer(scrubbed)),
        *_authorization_spans(scrubbed),
        *_nested_userinfo_spans(scrubbed, kept),
    ]
    if changes or net:
        spans += _spans_beside_urls(
            [*_outside_userinfo(credentials, userinfo), *_outside_urls(text, net, changes)], changes
        )
    if whole:
        spans += _rewritten_spans(scrubbed, whole)
    if cut:
        spans += _cut_scheme_spans(scrubbed)
    return _redact_spans(scrubbed, spans)


def _cut_scheme_spans(text: str) -> list[tuple[int, int]]:
    """Where a cut text ends inside a scheme or its ``://``, the rest of the URL cut off: the
    scheme characters it ends in, read back as a scheme is, with a ``:`` or ``:/`` after them."""
    index = len(text) - (2 if text.endswith(":/") else 1 if text.endswith(":") else 0)
    start = index
    while start > 0 and index - start < 64 and text[start - 1] in _SCHEME_CHARACTERS:
        start -= 1
    while start < index and text[start] not in _SCHEME_LETTERS:
        start += 1
    return [(start, len(text))] if start < index else []


# One piece of a URL as read before escaped quotes were: a run of characters that are not
# whitespace, a quote or ``<>``, a closed quoted value right after ``=``, or a quote after ``=``.
_PLAIN_URL_PIECE = re.compile(
    rf"[^{_JS_SPACE}\"'<>`]+|(?<==)\"[^\"<>`\r\n]*\"|(?<==)'[^'<>`\r\n]*'|(?<==)[\"']"
)
_AUTHORITY_END = re.compile(r"[/\\?#]")
_LETTER_OR_DIGIT = re.compile("[a-z0-9]", re.IGNORECASE | re.ASCII)


def _plain_url_spans(
    text: str,
) -> tuple[list[tuple[int, int]], list[tuple[int, int]], list[tuple[int, int]]]:
    """What the text hides with each URL read as before escaped quotes were, where it lies in the
    text, each list sorted by start. The first is all of a URL with another scheme holding ``@``,
    ``?`` or ``#``, or of one the parser refuses, and each pair, scheme or prefixed-token credential
    of the text with its URLs replaced as that reading replaces them, one starting or ending in a
    URL starting or ending with it. The second
    is each other URL's userinfo, after any ``/`` or ``\\`` that follow its ``://``, as the parser
    skips them, and the third its query values and fragment."""
    spans: list[tuple[int, int]] = []
    userinfo: list[tuple[int, int]] = []
    values: list[tuple[int, int]] = []
    changes: list[tuple[int, int, int]] = []
    parts: list[str] = []
    scrub = _Scrub()
    # Each URL's scrubbed text, as a text can repeat one many times.
    scrubbed: dict[str, str] = {}
    copied = 0
    index = text.find("://")
    while index != -1:
        end = index + 3
        if index >= copied:
            start = index
            while start > copied and index - start < 64 and text[start - 1] in _SCHEME_CHARACTERS:
                start -= 1
            while start < index and text[start] not in _SCHEME_LETTERS:
                start += 1
            while start < index and (piece := _PLAIN_URL_PIECE.match(text, end)) is not None:
                end = piece.end()
        if end > index + 3:
            url = text[start:end]
            if _SPECIAL_TEXT_SCHEME.match(url):
                replaced = scrubbed.get(url) or scrubbed.setdefault(url, scrub.url(url))
            else:
                replaced = REDACTED if _URL_PARTS.search(url) else url
            parts.append(text[copied:start] + replaced)
            copied = end
            if replaced != url:
                changes.append((start, end, len(replaced) - len(url)))
            if replaced == REDACTED:
                spans.append((start, end))
            else:
                authority, at = _userinfo_span(text, index, end)
                if at > authority:
                    userinfo.append((authority, at))
                hash_at = text.find("#", start, end)
                tail = end if hash_at == -1 else hash_at
                question = text.find("?", start, tail)
                if question != -1:
                    part = question + 1
                    for piece_text in text[question + 1 : tail].split("&"):
                        equals = piece_text.find("=")
                        if equals != -1 and equals + 1 < len(piece_text):
                            values.append((part + equals + 1, part + len(piece_text)))
                        part += len(piece_text) + 1
                if hash_at != -1:
                    values.append((hash_at, end))
        index = text.find("://", index + 1)
    if not changes:
        return spans, userinfo, values
    parts.append(text[copied:])
    replaced_text = "".join(parts)
    hidden = sorted(
        spans
        + _spans_before_urls(
            [
                *_pair_spans(replaced_text),
                *_authorization_spans(replaced_text),
                *(match.span() for match in _PREFIXED_TOKEN.finditer(replaced_text)),
            ],
            changes,
        )
    )
    return hidden, userinfo, values


def _outside_userinfo(
    spans: list[tuple[int, int]], userinfo: list[tuple[int, int]]
) -> list[tuple[int, int]]:
    """The spans of ``spans`` (sorted by start) that do not start inside a span of ``userinfo``
    (sorted, disjoint)."""
    kept: list[tuple[int, int]] = []
    following = 0
    for span in spans:
        while following < len(userinfo) and userinfo[following][1] <= span[0]:
            following += 1
        if not (following < len(userinfo) and userinfo[following][0] <= span[0]):
            kept.append(span)
    return kept


def _spans_before_urls(
    spans: list[tuple[int, int]], changes: list[tuple[int, int, int]]
) -> list[tuple[int, int]]:
    """The spans of a text whose URLs ``changes`` replaced, moved back to where their text lies
    before: one starting or ending inside a replacement starts or ends with its URL."""
    # Where each replacement starts and ends in the text, and how much longer the text is after it.
    growth = list(accumulate(change[2] for change in changes))
    starts = [change[0] + (growth[i - 1] if i else 0) for i, change in enumerate(changes)]
    ends = [change[1] + growth[i] for i, change in enumerate(changes)]
    moved: list[tuple[int, int]] = []
    for start, end in spans:
        begin, stop = start, end
        first = bisect_right(starts, start) - 1
        if first != -1:
            begin = changes[first][0] if start < ends[first] else start - growth[first]
        final = bisect_left(starts, end) - 1
        if final != -1:
            stop = changes[final][1] if end <= ends[final] else end - growth[final]
        moved.append((begin, stop))
    return moved


def _outside_urls(
    text: str, spans: list[tuple[int, int]], found: list[tuple[int, int, int]]
) -> list[tuple[int, int]]:
    """The parts of ``spans`` outside every URL ``found`` replaced (both sorted by start) that hold
    a letter or digit."""
    parts: list[tuple[int, int]] = []
    first = 0
    for begin, stop in spans:
        while first < len(found) and found[first][1] <= begin:
            first += 1
        cursor = begin
        following = first
        while following < len(found) and found[following][0] < stop:
            if found[following][0] > cursor:
                parts.append((cursor, found[following][0]))
            cursor = max(cursor, found[following][1])
            following += 1
        if cursor < stop:
            parts.append((cursor, stop))
    return [part for part in parts if _LETTER_OR_DIGIT.search(text, *part)]


def _rewritten_spans(text: str, whole: list[tuple[int, str]]) -> list[tuple[int, int]]:
    """The pair and scheme spans of the text with each URL replaced whole rewritten instead, cut
    to the text outside those URLs and moved to where it is in ``text``."""
    parts: list[str] = []
    length = 0
    copied = 0
    changes: list[tuple[int, int, int]] = []
    for at, url in whole:
        before = text[copied:at]
        parts.append(before + url)
        changes.append(
            (length + len(before), length + len(before) + len(url), len(REDACTED) - len(url))
        )
        length += len(before) + len(url)
        copied = at + len(REDACTED)
    parts.append(text[copied:])
    rewritten = "".join(parts)
    return _spans_beside_urls([*_pair_spans(rewritten), *_authorization_spans(rewritten)], changes)


# A URL nested in another's path (``…/p&mongodb://u:…@…``): its ``://`` (or ``:\\``) and any more
# ``/`` or ``\``, then its userinfo to the last ``@`` before a ``/``, ``\``, ``?``, ``#`` or
# whitespace, as a URL's own userinfo is read.
_NESTED_USERINFO = re.compile(rf":[/\\]{{2}}[/\\]*[^{_JS_SPACE}/\\?#]*@")
_QUERY_OR_FRAGMENT = re.compile(r"[?#]")
_NESTED_SCHEME_SEPARATOR = re.compile(r":[/\\]{2}")
_PATH_START = re.compile(r"[/\\]")


def _nested_userinfo_spans(text: str, urls: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """The userinfo of each URL nested in the path of a URL not replaced whole, and the whole of
    one with another scheme that holds an ``@``: the path is kept and the nested URL is not read on
    its own."""
    spans: list[tuple[int, int]] = []
    for start, end in urls:
        authority = text.find("://", start, end) + 3
        boundary = _QUERY_OR_FRAGMENT.search(text, authority, end)
        path_end = end if boundary is None else boundary.start()
        slash = _PATH_START.search(text, authority, path_end)
        if slash is None:
            continue
        for match in _NESTED_USERINFO.finditer(text, slash.start(), path_end):
            if match.start() + 3 < match.end() - 1:
                spans.append((match.start() + 3, match.end() - 1))
        # A nested URL with another scheme and an ``@`` is replaced whole, to the path's end, as it
        # is when read on its own.
        last_at = text.rfind("@", slash.start(), path_end)
        for match in _NESTED_SCHEME_SEPARATOR.finditer(text, slash.start(), path_end):
            colon = match.start()
            if last_at < colon:
                break
            scheme_start = colon
            while (
                scheme_start > slash.start()
                and colon - scheme_start < 64
                and text[scheme_start - 1] in _SCHEME_CHARACTERS
            ):
                scheme_start -= 1
            while scheme_start < colon and text[scheme_start] not in _SCHEME_LETTERS:
                scheme_start += 1
            if scheme_start == colon or _SPECIAL_TEXT_SCHEME.fullmatch(
                text[scheme_start : colon + 1]
            ):
                continue
            spans.append((scheme_start, path_end))
            break
    return spans


def _spans_beside_urls(
    spans: list[tuple[int, int]], changes: list[tuple[int, int, int]]
) -> list[tuple[int, int]]:
    """The spans moved to where their text is once the URLs are replaced: one starting inside a
    replaced URL starts after it, and one ending inside one ends before it."""
    starts = [change[0] for change in changes]
    # How much longer the text is after each replacement.
    growth = list(accumulate(change[2] for change in changes))
    moved: list[tuple[int, int]] = []
    for start, end in spans:
        first = bisect_left(starts, start + 1) - 1
        begin = start if first == -1 else max(start, changes[first][1]) + growth[first]
        final = bisect_left(starts, end) - 1
        if final == -1:
            stop = end
        elif end < changes[final][1]:
            stop = changes[final][0] + (growth[final - 1] if final else 0)
        else:
            stop = end + growth[final]
        if begin < stop:
            moved.append((begin, stop))
    return moved


def _is_url_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    normalized = key.lower().replace("-", "").replace("_", "")
    return normalized in {"serverurl", "url"}


# WHATWG URL parsing, for the special schemes a hosted endpoint uses, so a scrubbed URL with an
# ordinary host is serialized as the TypeScript SDK's `URL` serializes it.
_SPECIAL_PORTS = {"ftp": 21, "http": 80, "https": 443, "ws": 80, "wss": 443}
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*:")
_TAB_OR_NEWLINE = re.compile("[\t\n\r]")
_C0_OR_SPACE = "".join(map(chr, range(0x21)))
_FORBIDDEN_HOST = frozenset("\x00\t\n\r #/:<>?@[\\]^|")
_FORBIDDEN_DOMAIN = _FORBIDDEN_HOST | frozenset(map(chr, range(0x20))) | {"%", "\x7f"}
_FORBIDDEN_DOMAIN_CHARACTER = re.compile(
    "[" + "".join(re.escape(char) for char in sorted(_FORBIDDEN_DOMAIN)) + "]"
)
_PATH_ESCAPED = frozenset(' "#<>?^`{}')
_SINGLE_DOT = frozenset({".", "%2e"})
_DOUBLE_DOT = frozenset({"..", ".%2e", "%2e.", "%2e%2e"})
_HEX = frozenset(b"0123456789abcdefABCDEF")
_FORM_SAFE = frozenset(b"*-._0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")


class _InvalidUrl(ValueError):
    """A URL the WHATWG parser refuses."""


def _percent_encode(text: str) -> str:
    """UTF-8 percent-encode a path segment with the WHATWG path percent-encode set."""
    return "".join(
        "".join(f"%{byte:02X}" for byte in char.encode("utf-8"))
        if char in _PATH_ESCAPED or not 0x20 <= ord(char) <= 0x7E
        else char
        for char in text
    )


def _percent_decode(data: bytes) -> bytes:
    """WHATWG percent-decoding: each ``%`` and two hex digits is that byte, any other ``%`` is
    kept, as ``unquote_to_bytes`` decodes."""
    return unquote_to_bytes(data) if b"%" in data else data


# Each byte's application/x-www-form-urlencoded serialization, for ``str.translate`` over the
# bytes read as Latin-1, which is linear in C where a loop over the bytes is not.
_FORM_BYTES = {
    byte: "+" if byte == 0x20 else chr(byte) if byte in _FORM_SAFE else f"%{byte:02X}"
    for byte in range(256)
}


def _form_encode(text: str) -> str:
    """The application/x-www-form-urlencoded serialization of one name or value."""
    return text.encode("utf-8").decode("latin-1").translate(_FORM_BYTES)


_FORM_REDACTED = _form_encode(REDACTED)
# ``_FORM_BYTES`` for names joined by ``&``, which can then only separate them: each ``&`` ends a
# name and its redacted value, and in names not yet decoded a ``+`` is a space, written ``+``.
_JOINED_NAMES = {**_FORM_BYTES, 0x26: f"={_FORM_REDACTED}&"}
_JOINED_RAW_NAMES = {**_JOINED_NAMES, 0x2B: "+"}


def _query_names(query: str) -> list[str]:
    """The names ``URLSearchParams`` reads from a query, in order."""
    names = []
    for pair in query.encode("utf-8").split(b"&"):
        if pair:
            name = pair.split(b"=", 1)[0].replace(b"+", b" ")
            names.append(_percent_decode(name).decode("utf-8", "replace"))
    return names


def _redacted_query(query: str) -> str:
    """A query as ``URLSearchParams`` serializes it with every value ``[redacted]``. The names are
    decoded and encoded together, which gives each one's own text unless an escaped ``&``
    (``%26``) could be taken for a separator, and a long query costs a few passes in C."""
    names = [pair.partition(b"=")[0] for pair in query.encode("utf-8").split(b"&") if pair]
    if not names:
        return ""
    joined = b"&".join(names)
    if b"%" not in joined:
        # UTF-8 from a str, with no escape to decode: each byte is written as it reads.
        text = joined.decode("latin-1").translate(_JOINED_RAW_NAMES)
    elif b"%26" not in joined:
        decoded = unquote_to_bytes(joined.replace(b"+", b" ")).decode("utf-8", "replace")
        text = decoded.encode("utf-8").decode("latin-1").translate(_JOINED_NAMES)
    else:
        return "&".join(f"{_form_encode(name)}={_FORM_REDACTED}" for name in _query_names(query))
    return f"{text}={_FORM_REDACTED}"


# Characters of an IDN host WHATWG parsing is attempted for; the DNS allows 253.
_MAX_IDN_HOST = 1024
_RADIX_DIGITS = {8: frozenset("01234567"), 10: frozenset("0123456789")}
_RADIX_DIGITS[16] = frozenset("0123456789abcdefABCDEF")


def _ipv4_number(part: str) -> int | None:
    radix = 10
    if part[:2] in ("0x", "0X"):
        part, radix = part[2:], 16
    elif len(part) > 1 and part[0] == "0":
        part, radix = part[1:], 8
    if not part:
        return 0 if radix != 10 else None
    if not set(part) <= _RADIX_DIGITS[radix]:
        return None
    # Leading zeros do not count, and anything longer is out of range for an IPv4 part; neither
    # may reach int(), which refuses more than about 4,300 decimal digits.
    digits = part.lstrip("0") or "0"
    return int(digits, radix) if len(digits) <= 12 else 1 << 64


def _ends_in_number(domain: str) -> bool:
    parts = domain.split(".")
    if parts[-1] == "":
        if len(parts) == 1:
            return False
        parts.pop()
    last = parts[-1]
    return bool(last) and (last.isascii() and last.isdigit() or _ipv4_number(last) is not None)


def _ipv4(domain: str) -> str:
    parts = domain.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    numbers = [_ipv4_number(part) for part in parts]
    if len(parts) > 4 or any(number is None for number in numbers):
        raise _InvalidUrl
    values = [number for number in numbers if number is not None]
    if any(number > 255 for number in values[:-1]) or values[-1] >= 256 ** (5 - len(values)):
        raise _InvalidUrl
    address = values[-1] + sum(
        number * 256 ** (3 - index) for index, number in enumerate(values[:-1])
    )
    return ".".join(str(address >> shift & 255) for shift in (24, 16, 8, 0))


def _ipv6(text: str) -> str:
    if "%" in text:
        raise _InvalidUrl
    try:
        value = int(ipaddress.IPv6Address(text))
    except ValueError:
        raise _InvalidUrl from None
    pieces = [value >> (112 - 16 * index) & 0xFFFF for index in range(8)]
    # Compress the first longest run of two or more zero pieces.
    start, length, index = -1, 1, 0
    while index < 8:
        end = index
        while end < 8 and pieces[end] == 0:
            end += 1
        if end - index > length:
            start, length = index, end - index
        index = max(end, index + 1)
    hexes = [f"{piece:x}" for piece in pieces]
    if start < 0:
        return ":".join(hexes)
    return ":".join(hexes[:start]) + "::" + ":".join(hexes[start + length :])


def _remap(domain: str) -> str:
    try:
        # A dependency of requests, imported only for an IDN host; without it the host is
        # refused rather than serialized differently.
        import idna

        return idna.uts46_remap(domain, std3_rules=False, transitional=False)
    except (ImportError, UnicodeError, ValueError):
        raise _InvalidUrl from None


_RTL_ALLOWED = frozenset({"R", "AL", "AN", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"})


def _bidi_valid(label: str) -> bool:
    """RFC 5893 rules 2 to 4 for a label that begins with right-to-left text (a letter or an
    Arabic digit), as the Node.js parser applies them: only such characters, ending on a strong
    or numeric one, and not both kinds of digits. Bun's parser applies all six rules, so it
    refuses a few more labels."""
    classes = [unicodedata.bidirectional(char) for char in label]
    if not classes or classes[0] not in ("R", "AL", "AN"):
        return True
    end = len(classes)
    while end and classes[end - 1] == "NSM":
        end -= 1
    return (
        set(classes) <= _RTL_ALLOWED
        and end > 0
        and classes[end - 1] in ("R", "AL", "EN", "AN")
        and not {"EN", "AN"} <= set(classes)
    )


def _joiners_valid(label: str) -> bool:
    """RFC 5892 ContextJ: a joiner follows a virama. A zero-width non-joiner between Arabic
    letters is also valid there; that joining-type rule is not checked and it is refused."""
    return all(
        index > 0 and unicodedata.combining(label[index - 1]) == 9
        for index, char in enumerate(label)
        if char in "\u200c\u200d"
    )


def _domain_to_ascii(domain: str) -> str:
    """UTS 46 ToASCII with WHATWG's options: the mapping, the validity criteria, CheckJoiners
    and CheckBidi as ``_bidi_valid`` describes, and Punycode. It differs from the TypeScript
    SDK's parser only at the edges: an IDN host over ``_MAX_IDN_HOST`` characters and a
    non-joiner in an Arabic joining context are refused here."""
    if domain.isascii() and not any(label[:4].lower() == "xn--" for label in domain.split(".")):
        return domain.lower()
    # Mapping and Punycode grow faster than the host, so a longer IDN host is refused before
    # either runs, whatever the idna version.
    if len(domain) > _MAX_IDN_HOST:
        raise _InvalidUrl
    labels = _remap(domain).split(".")
    unicode_labels = []
    for label in labels:
        if label.startswith("xn--"):
            try:
                decoded = label[4:].encode("ascii").decode("punycode")
            except (UnicodeError, ValueError):
                raise _InvalidUrl from None
            if (
                not decoded
                or decoded.isascii()
                or decoded[:4].lower() == "xn--"
                or _remap(decoded) != decoded
                or not unicodedata.is_normalized("NFC", decoded)
            ):
                raise _InvalidUrl
            label = decoded
        if label and (unicodedata.category(label[0]).startswith("M") or not _joiners_valid(label)):
            raise _InvalidUrl
        unicode_labels.append(label)
    if not all(_bidi_valid(label) for label in unicode_labels):
        raise _InvalidUrl
    return ".".join(
        label if label.isascii() else "xn--" + label.encode("punycode").decode("ascii")
        for label in unicode_labels
    )


def _host(text: str) -> str:
    if text.startswith("["):
        if not text.endswith("]"):
            raise _InvalidUrl
        return f"[{_ipv6(text[1:-1])}]"
    domain = _domain_to_ascii(_percent_decode(text.encode("utf-8")).decode("utf-8", "replace"))
    if not domain or _FORBIDDEN_DOMAIN_CHARACTER.search(domain):
        raise _InvalidUrl
    return _ipv4(domain) if _ends_in_number(domain) else domain


def _path(path: str) -> str:
    segments: list[str] = []
    parts = re.split(r"[/\\]", path)[1:] if path else [""]
    for index, part in enumerate(parts):
        last = index == len(parts) - 1
        if part.lower() in _DOUBLE_DOT:
            if segments:
                segments.pop()
            if last:
                segments.append("")
        elif part.lower() in _SINGLE_DOT:
            if last:
                segments.append("")
        else:
            segments.append(_percent_encode(part))
    return "".join("/" + segment for segment in segments)


def _scrub_special_url(scheme: str, rest: str) -> str | None:
    """A special-scheme URL without userinfo, query values and fragment, serialized as WHATWG
    does, or ``None`` when it has none of them. Raises ``_InvalidUrl`` for a URL WHATWG refuses."""
    rest = rest.lstrip("/\\")
    end = min([i for i in map(rest.find, "/\\?#") if i >= 0], default=len(rest))
    authority, rest = rest[:end], rest[end:]
    userinfo, at, hostport = authority.rpartition("@")
    if at and not hostport:
        raise _InvalidUrl
    if hostport.startswith("["):
        close = hostport.find("]")
        host_text, port_text = hostport[: close + 1], hostport[close + 1 :]
        if close < 0 or port_text and not port_text.startswith(":"):
            raise _InvalidUrl
        port_text = port_text[1:]
    else:
        host_text, _, port_text = hostport.partition(":")
    if not host_text:
        raise _InvalidUrl
    host = _host(host_text)
    port = None
    if port_text:
        digits = port_text.lstrip("0") or "0"
        if not set(port_text) <= _RADIX_DIGITS[10] or len(digits) > 5 or int(digits) > 65535:
            raise _InvalidUrl
        port = None if int(digits) == _SPECIAL_PORTS[scheme] else int(digits)
    rest, hashed, fragment = rest.partition("#")
    path, questioned, query = rest.partition("?")
    username, _, password = userinfo.partition(":")
    if not (username or password or query or fragment):
        return None
    serialized = f"{scheme}://{host}" + (f":{port}" if port is not None else "") + _path(path)
    if query:
        pairs = _redacted_query(query)
        serialized += f"?{pairs}" if pairs else ""
    elif questioned:
        serialized += "?"
    return serialized + ("#" if hashed and not fragment else "")


class _Scrub:
    def __init__(self) -> None:
        self.changed = False

    def url(self, value: str) -> str:
        """Remove URL userinfo and every query value from a hosted endpoint.

        Query parameter names are provider-defined, so retaining values based on a guessed
        credential-key list could leak a secret under an unfamiliar name. Fragments can also carry
        bearer tokens in provider-specific URLs, so they are removed too. A URL with a special
        scheme (``http``, ``https``, ``ws``, ``wss``, ``ftp``) is parsed and, when scrubbed,
        serialized as WHATWG ``URL`` does, so for ordinary hosts both SDKs export the same text
        and digest; ``_domain_to_ascii`` notes where IDN hosts can still differ.
        """
        text = _TAB_OR_NEWLINE.sub("", _LONE_SURROGATE.sub("\ufffd", value).strip(_C0_OR_SPACE))
        scheme = _SCHEME.match(text)
        if scheme and scheme.group()[:-1].lower() in _SPECIAL_PORTS:
            try:
                scrubbed = _scrub_special_url(scheme.group()[:-1].lower(), text[scheme.end() :])
            except ValueError:
                # Refused by WHATWG, or anything else that stops the parse: never export it.
                scrubbed = REDACTED
            if scrubbed is None:
                return value
            self.changed = True
            return scrubbed
        try:
            parsed = urlsplit(value)
        except ValueError:
            # A malformed URL may still contain a credential. Do not export an opaque URL-valued
            # string when it cannot be parsed safely.
            self.changed = True
            return REDACTED
        # Match the TypeScript URL parser: only absolute URLs can be inspected safely. A relative
        # or otherwise opaque URL-valued string is replaced rather than exported verbatim.
        if not parsed.scheme or not parsed.netloc:
            self.changed = True
            return REDACTED

        changed = False
        netloc = parsed.netloc
        if "@" in netloc:
            netloc = netloc.rsplit("@", 1)[1]
            changed = True
        query = parsed.query
        if query:
            # Keep parameter names for endpoint identity, but replace all values, including
            # values whose names are not recognizable credentials.
            query = urlencode(
                [(key, REDACTED) for key, _ in parse_qsl(query, keep_blank_values=True)]
            )
            changed = True
        fragment = parsed.fragment
        if fragment:
            fragment = ""
            changed = True
        if not changed:
            return value
        self.changed = True
        # WHATWG URL serialization inserts a slash for an empty absolute path.
        path = parsed.path or "/"
        return urlunsplit((parsed.scheme, netloc, path, query, fragment))

    def node(
        self,
        value: Any,
        depth: int = 0,
        parameters: bool = False,
        credential_parameter: bool = False,
    ) -> Any:
        """Replace every credential key's value at any depth.

        Keys directly inside a JSON Schema ``properties`` object name tool parameters (a tool
        may take a ``headers`` argument), so their schemas are kept and scrubbed like any other
        value.
        """
        if depth > _MAX_DEPTH:
            raise ValueError("Tool definition exceeds its nesting limit.")
        if isinstance(value, list):
            return [
                self.node(item, depth + 1, credential_parameter=credential_parameter)
                for item in value
            ]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, item in value.items():
            if credential_parameter and key in {"examples", "enum"}:
                self.changed = True
                result[key] = [REDACTED for _ in item] if isinstance(item, list) else REDACTED
            elif credential_parameter and key in {"default", "const"}:
                self.changed = True
                result[key] = REDACTED
            elif not parameters and item is not None and _is_credential_key(key):
                self.changed = True
                result[key] = REDACTED
            elif not parameters and isinstance(item, str) and _is_url_key(key):
                result[key] = self.url(item)
            else:
                result[key] = self.node(
                    item,
                    depth + 1,
                    key == "properties",
                    False
                    if key == "properties"
                    else credential_parameter or (parameters and _is_credential_key(key)),
                )
        return result


def _reject_constant(_name: str) -> Any:
    raise ValueError("NaN and Infinity are not JSON.")


def _parse_int(text: str) -> int | float:
    """A JSON integer as JavaScript reads it. CPython refuses ``int()`` of more than about 4,300
    digits, and ``JSON.parse`` reads such a number as an (infinite) double anyway."""
    try:
        return int(text)
    except ValueError:
        return float(text)


def _parse(text: str, *, strict: bool = False) -> Any:
    """Parse JSON text, returning ``None`` for text that is not JSON.

    ``strict`` also refuses the ``NaN``/``Infinity`` literals Python accepts, as JavaScript does.
    """
    try:
        if strict:
            return json.loads(text, parse_int=_parse_int, parse_constant=_reject_constant)
        return json.loads(text, parse_int=_parse_int)
    except ValueError:
        return None


def _finite(value: Any) -> Any:
    """Non-finite numbers become ``null``, as ``JSON.stringify`` writes them. Only called when
    the value has one, so deeply nested content without one never recurses here."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, list):
        return [_finite(item) for item in value]
    if isinstance(value, dict):
        return {key: _finite(item) for key, item in value.items()}
    return value


def _dump(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except ValueError:
        return json.dumps(_finite(value), ensure_ascii=False, separators=(",", ":"))


def _scrub_definition_text(text: str) -> str:
    parsed = _parse(text)
    if not isinstance(parsed, (dict, list)):
        return text
    scrub = _Scrub()
    scrubbed = scrub.node(parsed)
    return _dump(scrubbed) if scrub.changed else text


def _scrub_request_text(text: str) -> str:
    """Replace credentials in the ``tools`` and ``mcp_servers`` entries of a raw request only."""
    if '"tools"' not in text and '"mcp_servers"' not in text:
        return text
    parsed = _parse(text)
    if not isinstance(parsed, dict):
        return text
    scrub = _Scrub()
    request = dict(parsed)
    for field in ("tools", "mcp_servers"):
        if isinstance(request.get(field), (dict, list)):
            request[field] = scrub.node(request[field])
    return _dump(request) if scrub.changed else text


def scrub_tool_credentials(key: str, value: Any) -> Any:
    """Remove hosted-tool credentials from an exported attribute value.

    Tool definitions come from OpenTelemetry GenAI (``gen_ai.tool.definitions``), AI SDK 6
    (``ai.prompt.tools``, one JSON string per tool) and OpenInference
    (``llm.tools.{i}.tool.json_schema``, plus the raw request in ``input.value``). Other
    attributes, and values that are not JSON, are returned unchanged. Metadata-only export
    removes all of these attributes anyway. A definition nested too deeply to inspect raises
    ``ValueError`` so the record is dropped rather than exported with credentials.
    """
    if key in _DEFINITION_KEYS or _OPENINFERENCE_TOOL.match(key):
        scrub = _scrub_definition_text
    elif key in _REQUEST_KEYS:
        scrub = _scrub_request_text
    else:
        return value
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, (list, tuple)):
        return type(value)(scrub(item) if isinstance(item, str) else item for item in value)
    return value


def _is_name(value: Any) -> bool:
    """A usable tool name: non-blank, at most 256 UTF-16 units, well-formed and free of NUL."""
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        return False
    try:
        return len(value.encode("utf-16-le")) <= 512
    except UnicodeEncodeError:
        return False


def _tool_name(definition: Any) -> str | None:
    """``name``, else Chat Completions' ``function.name``, else an unnamed built-in's ``type``."""
    if not isinstance(definition, dict):
        return None
    function = definition.get("function")
    nested = function.get("name") if isinstance(function, dict) else None
    for candidate in (definition.get("name"), nested, definition.get("type")):
        if _is_name(candidate):
            return str(candidate)
    return None


def _utf8_size(value: str, limit: int) -> int:
    """Count UTF-8 bytes without allocating an encoded copy beyond ``limit``."""
    size = 0
    for character in value:
        code = ord(character)
        size += 1 if code <= 0x7F else 2 if code <= 0x7FF else 3 if code <= 0xFFFF else 4
        if size > limit:
            return size
    return size


def _parse_definitions(texts: list[Any]) -> list[Any] | None:
    # Admission runs on the application thread, and export removes these attributes unbudgeted:
    # definitions longer than one export request are not parsed and get no summary.
    if (
        sum(_utf8_size(text, MAX_REQUEST_BYTES) for text in texts if isinstance(text, str))
        > MAX_REQUEST_BYTES
    ):
        return None
    parsed = [_parse(text, strict=True) if isinstance(text, str) else None for text in texts]
    return parsed if all(isinstance(item, (dict, list)) for item in parsed) else None


def _definitions_of(source: Mapping[str, Any]) -> list[Any] | None:
    """``gen_ai.tool.definitions``, else ``ai.prompt.tools``, else ``llm.tools.{i}`` by index."""
    if "gen_ai.tool.definitions" in source:
        parsed = _parse_definitions([source["gen_ai.tool.definitions"]])
        if parsed is None:
            return None
        return parsed[0] if isinstance(parsed[0], list) else parsed
    if "ai.prompt.tools" in source:
        tools = source["ai.prompt.tools"]
        return _parse_definitions(list(tools) if isinstance(tools, (list, tuple)) else [tools])
    indexed = []
    for key, value in source.items():
        match = _OPENINFERENCE_TOOL.match(key) if isinstance(key, str) else None
        if match:
            indexed.append((int(match.group(1)), value))
    indexed.sort(key=lambda item: item[0])
    return _parse_definitions([value for _, value in indexed]) if indexed else None


def _es_number(value: float) -> str:
    """ECMAScript ``Number.prototype.toString``, as RFC 8785 requires; non-finite is ``null``."""
    if value != value or value in (float("inf"), float("-inf")):
        return "null"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    mantissa, _, exponent = repr(abs(value)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    point = len(whole) + (int(exponent) if exponent else 0)
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    if len(digits) <= point <= 21:
        return sign + digits + "0" * (point - len(digits))
    if 0 < point <= 21:
        return sign + digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return sign + "0." + "0" * -point + digits
    scale = point - 1
    return (
        sign
        + digits[0]
        + ("." + digits[1:] if len(digits) > 1 else "")
        + "e"
        + ("+" if scale >= 0 else "-")
        + str(abs(scale))
    )


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _json_string(value: str) -> str:
    # JSON.stringify escapes unpaired surrogates; json.loads already joined the valid pairs.
    text = json.dumps(value, ensure_ascii=False)
    return _LONE_SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", text)


def _canonical(value: Any) -> str:
    """RFC 8785 (JCS) canonical JSON, byte-identical to the TypeScript SDK's."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if abs(value) <= 2**53:
            return str(value)
        try:
            return _es_number(float(value))
        except OverflowError:
            return "null"
    if isinstance(value, float):
        return _es_number(value)
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        members = sorted(
            value.items(), key=lambda item: item[0].encode("utf-16-be", "surrogatepass")
        )
        return (
            "{" + ",".join(f"{_json_string(key)}:{_canonical(item)}" for key, item in members) + "}"
        )
    raise TypeError("Unsupported JSON value.")


def with_tool_catalog_summary(source: Mapping[str, Any]) -> Mapping[str, Any]:
    """Add the metadata-only summary of the tool definitions a record carries.

    ``hue.tool.names`` lists each definition's name in order, and ``hue.tool.definitions.sha256``
    is the lowercase hex SHA-256 of the RFC 8785 canonical JSON of the credential-scrubbed
    definition list, identical to the TypeScript SDK's. Export then removes the definitions.
    Returns the source unchanged when it has no parseable definitions; attributes the source
    already sets are kept.
    """
    try:
        definitions = _definitions_of(source)
        if definitions is None:
            return source
        scrubbed = _Scrub().node(definitions)
        names = [name for name in map(_tool_name, definitions) if name is not None]
        summary: dict[str, Any] = {"hue.tool.names": names} if names else {}
        summary["hue.tool.definitions.sha256"] = hashlib.sha256(
            _canonical(scrubbed).encode("utf-8")
        ).hexdigest()
    except Exception:
        # Metadata-only export removes the definitions whether or not they can be summarized.
        return source
    return {**summary, **source}


def tool_catalog_summary(definitions: str) -> dict[str, Any]:
    """The metadata-only summary of one JSON-encoded definition list.

    ``hue.tool.names`` and ``hue.tool.definitions.sha256``, exactly as export summarizes a
    record's ``gen_ai.tool.definitions``; empty when the list cannot be summarized.
    """
    summarized = with_tool_catalog_summary({"gen_ai.tool.definitions": definitions})
    return {
        key: summarized[key]
        for key in ("hue.tool.names", "hue.tool.definitions.sha256")
        if key in summarized
    }
