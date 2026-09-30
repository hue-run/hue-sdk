"""Opt-in session, user and workspace identity carried as W3C ``baggage``; internal.

Mirrors ``propagation.ts`` in the TypeScript SDK: both write byte-identical members for the same
identifiers and read each other's output identically (``identity-baggage.json``).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, MutableMapping
from contextvars import ContextVar
from typing import Any, TypeGuard
from urllib.parse import quote, unquote_to_bytes

from opentelemetry import context as otel_context
from opentelemetry.context import Context
from opentelemetry.util.types import AttributeValue

# Span attribute keys, in the order their members are written.
IDENTITY_KEYS = ("gen_ai.conversation.id", "user.id", "hue.workspace.id")
MEMBERS = {
    "gen_ai.conversation.id": "hue.session.id",
    "user.id": "hue.user.id",
    "hue.workspace.id": "hue.workspace.id",
}
_KEY_BY_MEMBER = {member: key for key, member in MEMBERS.items()}

_MAX_BAGGAGE_BYTES = 8192
_MAX_READ_MEMBERS = 180
_MAX_WRITE_MEMBERS = 64
_MAX_MEMBER_BYTES = 4096

# Hue's private key for an identity read by ``Hue.extract(..., identity=True)``; never OTel baggage.
REMOTE_IDENTITY_KEY = otel_context.create_key("hue_identity")

# Identifier attributes of the innermost ``hue.context()`` block, or of a ``span()`` that applied
# a remote identity, for the static ``Hue.inject``. Set and reset with ``_context_attributes``.
identity_scope: ContextVar[Mapping[str, AttributeValue] | None] = ContextVar(
    "hue_identity_scope", default=None
)

# W3C baggage-octets (``%`` included), and a ``%`` that does not start a two-digit hex escape.
_BAGGAGE_OCTETS = re.compile(r"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+")
_BARE_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")


def is_identifier(value: object) -> TypeGuard[str]:
    """1–4096 UTF-16 code units, no NUL and no lone surrogate; only an exact ``str``."""
    if type(value) is not str or not value or "\x00" in value:
        return False
    try:
        return len(value.encode("utf-16-le")) // 2 <= 4096
    except UnicodeEncodeError:
        return False


def identity_fields(source: object) -> dict[str, str]:
    """The valid identifier attributes of ``source``, without calling any application hooks."""
    fields: dict[str, str] = {}
    if not isinstance(source, Mapping):
        return fields
    for key in IDENTITY_KEYS:
        value = source.get(key)
        if is_identifier(value):
            fields[key] = value
    return fields


def remote_identity(ctx: Context) -> dict[str, str] | None:
    """The identity an opted-in ``extract`` put on ``ctx``, re-validated."""
    fields = identity_fields(otel_context.get_value(REMOTE_IDENTITY_KEY, ctx))
    return fields or None


def with_remote_identity(ctx: Context, fields: Mapping[str, str]) -> Context:
    return otel_context.set_value(REMOTE_IDENTITY_KEY, dict(fields), ctx)


def without_remote(ctx: Context) -> Context:
    """``ctx`` itself when it carries no remote identity, else a copy without it."""
    if otel_context.get_value(REMOTE_IDENTITY_KEY, ctx) is None:
        return ctx
    return otel_context.set_value(REMOTE_IDENTITY_KEY, None, ctx)


def _trim(text: str) -> str:
    return text.strip(" \t")


def _member_key(member: str) -> str:
    """The text before the first ``=`` and before any ``;``, without optional whitespace."""
    return _trim(member.split("=", 1)[0].split(";", 1)[0])


def _byte_length(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


def merge_identity_baggage(existing: str | None, identity: Mapping[str, str]) -> str | None:
    """Strip every Hue member from ``existing``, then append ``identity``'s members when they fit.

    Other members keep their bytes and order; with nothing stripped ``existing`` is a prefix of the
    result. ``None`` means the header should not exist. A member over 4,096 bytes is omitted, and
    a header too crowded to add to (8,192 bytes or 64 members) is only stripped.
    """
    source = existing or ""
    pieces = source.split(",")
    kept = [piece for piece in pieces if _member_key(piece) not in _KEY_BY_MEMBER]
    stripped = len(kept) != len(pieces)
    base = ",".join(kept) if stripped else source
    if stripped:
        base_members = len([piece for piece in kept if _trim(piece)])
    elif not _trim(source):
        base_members = 0
    else:
        base_members = len([piece for piece in pieces if _trim(piece)])
    own: list[str] = []
    for key in IDENTITY_KEYS:
        identifier = identity.get(key)
        if not is_identifier(identifier):
            continue
        member = f"{MEMBERS[key]}={quote(identifier, safe='')}"
        if len(member) <= _MAX_MEMBER_BYTES:
            own.append(member)
    value: str | None = base
    if own:
        candidate = ",".join(own) if base_members == 0 else f"{base},{','.join(own)}"
        if (
            base_members + len(own) <= _MAX_WRITE_MEMBERS
            and _byte_length(candidate) <= _MAX_BAGGAGE_BYTES
        ):
            value = candidate
    if not stripped and value == source:
        return existing
    if value is not None and not value.replace(",", "").strip(" \t"):
        return None
    return value


def _decode(raw: str) -> str | None:
    # Every ``%`` must start an escape; neither expression backtracks.
    if not _BAGGAGE_OCTETS.fullmatch(raw) or _BARE_PERCENT.search(raw):
        return None
    try:
        # ``unquote`` would leave a malformed escape in place; ``+`` stays a literal ``+``.
        return unquote_to_bytes(raw).decode("utf-8", "strict")
    except UnicodeDecodeError:
        return None


def read_identity_baggage(value: object) -> dict[str, str] | None:
    """The Hue members of a ``baggage`` value, keyed by span attribute. Untrusted input: a header
    over 8,192 bytes or 180 members yields nothing, and an invalid or conflicting member drops its
    field. Nothing is raised, logged or counted."""
    if type(value) is not str:
        return None
    if len(value) > _MAX_BAGGAGE_BYTES or _byte_length(value) > _MAX_BAGGAGE_BYTES:
        return None
    members = value.split(",")
    if len([member for member in members if _trim(member)]) > _MAX_READ_MEMBERS:
        return None
    found: dict[str, str] = {}
    refused: set[str] = set()
    for member in members:
        raw_key, equals, rest = member.partition("=")
        if not equals or ";" in raw_key:
            continue
        key = _KEY_BY_MEMBER.get(_trim(raw_key))
        if key is None:
            continue
        decoded = _decode(_trim(rest.split(";", 1)[0]))
        previous = found.get(key)
        # An invalid value, or a second value that differs, fails closed for that field.
        if decoded is None or not is_identifier(decoded) or previous not in (None, decoded):
            refused.add(key)
        else:
            found[key] = decoded
    for key in refused:
        found.pop(key, None)
    return found or None


def _baggage_key(headers: Mapping[str, Any]) -> str:
    if "baggage" in headers:
        return "baggage"
    for key in list(headers.keys()):
        if type(key) is str and key.lower() == "baggage":
            return key
    return "baggage"


def read_carrier(headers: Mapping[str, Any]) -> dict[str, str] | None:
    """The identity in ``headers``' baggage; case-insensitive mappings answer ``baggage``."""
    value = headers.get("baggage")
    if value is None:
        value = headers.get(_baggage_key(headers))
    return read_identity_baggage(value)


def inject_identity(headers: MutableMapping[str, str], identity: Mapping[str, str]) -> None:
    """Rewrite ``headers``' baggage with ``identity``; a value that is not a ``str`` stays as is."""
    key = "baggage"
    existing: Any = headers.get("baggage")
    if existing is None:
        key = _baggage_key(headers)
        existing = headers.get(key)
    if existing is not None and type(existing) is not str:
        return
    value = merge_identity_baggage(existing, identity)
    if value is not None:
        headers[key] = value
    elif existing is not None:
        del headers[key]


def current_identity() -> dict[str, str]:
    """Per field: the innermost Hue scope, else a remote identity attached as current context."""
    return {
        **(remote_identity(otel_context.get_current()) or {}),
        **identity_fields(identity_scope.get()),
    }
