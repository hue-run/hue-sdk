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

# A dependency of requests; its UTS 46 table maps IDN hosts as WHATWG URL parsing does.
import idna

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


def _is_url_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    normalized = key.lower().replace("-", "").replace("_", "")
    return normalized in {"serverurl", "url"}


# WHATWG URL parsing, for the special schemes a hosted endpoint uses, so a scrubbed URL is
# serialized as the TypeScript SDK's `URL` serializes it and both SDKs digest the same text.
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


def _ipv4_number(part: str) -> int | None:
    radix = 10
    if part[:2] in ("0x", "0X"):
        part, radix = part[2:], 16
    elif len(part) > 1 and part[0] == "0":
        part, radix = part[1:], 8
    if not part:
        return 0 if radix != 10 else None
    try:
        return int(part, radix) if part.isascii() and part.isalnum() else None
    except ValueError:
        return None


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
        return idna.uts46_remap(domain, std3_rules=False, transitional=False)
    except (idna.IDNAError, UnicodeError, ValueError):
        raise _InvalidUrl from None


def _domain_to_ascii(domain: str) -> str:
    """UTS 46 ToASCII with WHATWG's options, for the mapping and Punycode steps. The IDNA 2008
    bidi and joiner context rules are not checked; a label with a joiner is refused."""
    if domain.isascii() and not any(label[:4].lower() == "xn--" for label in domain.split(".")):
        return domain.lower()
    labels = []
    for label in _remap(domain).split("."):
        if label.startswith("xn--"):
            try:
                decoded = label[4:].encode("ascii").decode("punycode")
            except (UnicodeError, ValueError):
                raise _InvalidUrl from None
            if (
                not decoded
                or decoded.isascii()
                or _remap(decoded) != decoded
                or not unicodedata.is_normalized("NFC", decoded)
            ):
                raise _InvalidUrl
        elif not label.isascii():
            if "\u200c" in label or "\u200d" in label:
                raise _InvalidUrl
            label = "xn--" + label.encode("punycode").decode("ascii")
        labels.append(label)
    return ".".join(labels)


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
        if not (port_text.isascii() and port_text.isdigit()) or int(port_text) > 65535:
            raise _InvalidUrl
        port = None if int(port_text) == _SPECIAL_PORTS[scheme] else int(port_text)
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
        scheme (``http``, ``https``, ``ws``, ``wss``, ``ftp``) is parsed and serialized as WHATWG
        ``URL`` does, so both SDKs export the same text and digest.
        """
        text = _TAB_OR_NEWLINE.sub("", _LONE_SURROGATE.sub("\ufffd", value).strip(_C0_OR_SPACE))
        scheme = _SCHEME.match(text)
        if scheme and scheme.group()[:-1].lower() in _SPECIAL_PORTS:
            try:
                scrubbed = _scrub_special_url(scheme.group()[:-1].lower(), text[scheme.end() :])
            except _InvalidUrl:
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
    """Non-finite numbers become ``null``, as ``JSON.stringify`` writes them."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, list):
        return [_finite(item) for item in value]
    if isinstance(value, dict):
        return {key: _finite(item) for key, item in value.items()}
    return value


def _dump(value: Any) -> str:
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
