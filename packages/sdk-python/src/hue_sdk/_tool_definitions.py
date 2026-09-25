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
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

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
# A URL's ``://`` and everything after it up to whitespace, a quote or ``<>``. A quoted value right
# after ``=`` (``?token="…"``) is part of the URL, so all of it is replaced.
_URL_REST = re.compile(
    rf"://(?:[^{_JS_SPACE}\"'<>`]|(?<==)\"[^\"<>`\r\n]*\""
    r"|(?<==)'[^'<>`\r\n]*'|(?<==)[\"'])+",
)
_SCHEME_LETTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
_SCHEME_CHARACTERS = _SCHEME_LETTERS | frozenset("0123456789+.-")
# Schemes WHATWG parses as hierarchical, which both SDKs serialize alike.
_SPECIAL_TEXT_SCHEME = re.compile(r"(?:https?|wss?|ftp):", re.IGNORECASE | re.ASCII)
_URL_PARTS = re.compile(r"[@?#]")
# A credential its own prefix identifies wherever it appears: Hue's API, MCP, world and attempt
# tokens, and OpenAI and Anthropic (``sk-``), Stripe, Slack, Google OAuth, GitHub and GitLab ones.
_PREFIXED_TOKEN = re.compile(
    r"\b(?:hue_(?:sk|mcp|world|attempt)_|sk-|[rs]k_(?:live|test)_|xox[abpors]-|xapp-|ya29\."
    r"|gh[opsur]_|github_pat_|glpat-)[a-z0-9_.~+/=-]{8,}",
    re.IGNORECASE | re.ASCII,
)
# An authorization scheme followed by its credential, as in an ``Authorization`` header, up to
# whitespace, a quote, a delimiter or a backslash. The credential cannot start with ``=``, so
# ``token = value`` is left to the key-value rule.
_AUTHORIZATION_VALUE = re.compile(
    rf"\b(bearer|basic|token)([{_JS_SPACE}]+)[^{_JS_SPACE}\"'`<>=,;(){{}}\[\]\\]"
    rf"[^{_JS_SPACE}\"'`<>,;(){{}}\[\]\\]*",
    re.IGNORECASE | re.ASCII,
)
# The key and separator of a ``key=value`` or ``key: value`` pair, the key optionally quoted, with
# a backslash-escaped quote too (JSON inside a string). A key starts where no key character
# precedes it, so each word is tried once and a long run stays linear. The value is not consumed,
# so a pair inside another pair's value (``error: token=…``) is found.
_PAIR_KEY = re.compile(
    rf"(\\?[\"']|)(?<![a-z0-9_-])([a-z0-9][a-z0-9_-]*)\1([{_JS_SPACE}]*[:=][{_JS_SPACE}]*)",
    re.IGNORECASE | re.ASCII,
)
# A quoted value to its closing quote on the same line, spaces and escaped quotes included, or one
# between backslash-escaped quotes.
_QUOTED_VALUE = re.compile(
    r"\"(?:[^\"\\\r\n]|\\[^\r\n])+\"|'(?:[^'\\\r\n]|\\[^\r\n])+'"
    r"|\\\"(?:[^\"\\\r\n]|\\[^\"\r\n])+\\\""
)
# An unquoted value, or one whose quote does not close on its line, up to whitespace, a quote or
# a delimiter; a value already replaced, or a scheme whose credential was, is left alone.
_BARE_VALUE = re.compile(
    rf"(\\?[\"']?)(?!\[redacted\]|%5Bredacted%5D|(?:bearer|basic|token)[{_JS_SPACE}])"
    rf"[^{_JS_SPACE}\"',;&}})\]]+",
    re.IGNORECASE | re.ASCII,
)
# An ``Authorization`` header's unquoted value: its scheme and the credential after it (``Bot …``,
# ``ApiKey …``), or a lone credential. One already replaced is left alone.
_AUTHORIZATION_BARE = re.compile(
    rf"(\\?[\"']?)(?!\[redacted\]|%5Bredacted%5D)[^{_JS_SPACE}\"',;}})\]]+"
    rf"(?:[ \t]+(?:\[redacted\]|[^{_JS_SPACE}\"',;}})\]]+))?"
)


def _scrub_text_urls(text: str) -> str:
    """Scrub each URL in free text. Each ``://`` is found by search and its scheme read back from
    it: up to 64 scheme characters, starting at a letter, so a longer run before ``://`` still
    leaves a URL to scrub and a long run such as ``a.a.a…`` costs one pass."""
    scrub = _Scrub()
    parts: list[str] = []
    copied = 0
    index = text.find("://")
    while index != -1:
        if index >= copied:
            start = index
            while start > copied and index - start < 64 and text[start - 1] in _SCHEME_CHARACTERS:
                start -= 1
            while start < index and text[start] not in _SCHEME_LETTERS:
                start += 1
            rest = _URL_REST.match(text, index) if start < index else None
            if rest is not None:
                url = text[start : rest.end()]
                if _SPECIAL_TEXT_SCHEME.match(url):
                    url = scrub.url(url)
                elif _URL_PARTS.search(url):
                    url = REDACTED
                parts.append(text[copied:start] + url)
                copied = rest.end()
        index = text.find("://", index + 1)
    parts.append(text[copied:])
    return "".join(parts)


def _normalized_key(key: str) -> str:
    return key.lower().replace("-", "").replace("_", "")


def _is_text_credential_key(key: str) -> bool:
    """A key naming a credential in free text: a tool definition's credential keys, any header
    ending in ``Authorization`` and ``Bearer``."""
    normalized = _normalized_key(key)
    return _is_credential_key(key) or normalized.endswith("authorization") or normalized == "bearer"


def _scrub_pairs(text: str) -> str:
    """Replace the value of each pair whose key names a credential."""
    parts: list[str] = []
    copied = 0
    for match in _PAIR_KEY.finditer(text):
        start = match.end()
        key = match[2]
        if start < copied or not _is_text_credential_key(key):
            continue
        quoted = _QUOTED_VALUE.match(text, start)
        bare = (
            _AUTHORIZATION_BARE if _normalized_key(key).endswith("authorization") else _BARE_VALUE
        )
        value = quoted or bare.match(text, start)
        if value is None:
            continue
        if quoted:
            quote = '\\"' if quoted[0].startswith("\\") else quoted[0][0]
            parts.append(f"{text[copied:start]}{quote}{REDACTED}{quote}")
        else:
            parts.append(f"{text[copied:start]}{value[1]}{REDACTED}")
        copied = value.end()
    parts.append(text[copied:])
    return "".join(parts)


def scrub_credential_text(text: str) -> str:
    """Remove credentials from free text a provider returned, such as an MCP error message.

    The rules are the tool definitions', extended for text: each ``http``, ``https``, ``ws``,
    ``wss`` or ``ftp`` URL loses its userinfo and fragment and every query value becomes
    ``[redacted]``, as a ``url`` field does (an unparseable one becomes ``[redacted]``), and a URL
    with any other scheme, which runtimes parse differently, becomes ``[redacted]`` when it has an
    ``@``, ``?`` or ``#``; a token with a known credential prefix (``hue_sk_``, ``sk-``,
    ``xoxb-``, ``ya29.`` and others), the credential after an authorization scheme (``Bearer``,
    ``Basic``, ``Token``), the whole value of an ``Authorization`` header, and the value of a
    ``key=value`` or ``key: value`` pair whose key names a credential (quoted, escaped-quoted or
    bare) become ``[redacted]``. Identical to the TypeScript SDK's ``scrubCredentialText``.
    """
    text = _scrub_text_urls(text)
    text = _PREFIXED_TOKEN.sub(REDACTED, text)
    text = _AUTHORIZATION_VALUE.sub(lambda match: f"{match[1]}{match[2]}{REDACTED}", text)
    return _scrub_pairs(text)


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
    decoded = bytearray()
    index = 0
    while index < len(data):
        if (
            data[index] == 0x25
            and index + 2 < len(data)
            and data[index + 1] in _HEX
            and data[index + 2] in _HEX
        ):
            decoded.append(int(data[index + 1 : index + 3], 16))
            index += 3
        else:
            decoded.append(data[index])
            index += 1
    return bytes(decoded)


def _form_encode(text: str) -> str:
    """The application/x-www-form-urlencoded serialization of one name or value."""
    return "".join(
        "+" if byte == 0x20 else chr(byte) if byte in _FORM_SAFE else f"%{byte:02X}"
        for byte in text.encode("utf-8")
    )


def _query_names(query: str) -> list[str]:
    """The names ``URLSearchParams`` reads from a query, in order."""
    names = []
    for pair in query.encode("utf-8").split(b"&"):
        if pair:
            name = pair.split(b"=", 1)[0].replace(b"+", b" ")
            names.append(_percent_decode(name).decode("utf-8", "replace"))
    return names


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
    if not domain or any(char in _FORBIDDEN_DOMAIN for char in domain):
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
        pairs = "&".join(
            f"{_form_encode(name)}={_form_encode(REDACTED)}" for name in _query_names(query)
        )
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
