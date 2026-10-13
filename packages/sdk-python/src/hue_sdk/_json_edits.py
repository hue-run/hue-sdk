"""Edits to recorded JSON text that keep every byte they do not change.

Placing a file in a value read from JSON text (an attribute, or a tool call's JSON-encoded
arguments) replaces only the file's own value, or the members of the part that held it; the rest of
the text, its key order, number spellings and whitespace included, is kept as it was recorded.
Mirrors the TypeScript SDK's ``json-edits.ts``, so both SDKs write the same bytes.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

# One change at a JSON pointer of a document: its value replaced by ``value`` (JSON text), or, for
# an object, the member ``remove`` dropped and each ``set`` member's value replaced in place or
# appended.


@dataclass(frozen=True)
class JsonEdit:
    pointer: str
    value: str | None = None
    remove: str | None = None
    set: tuple[tuple[str, str], ...] = ()


@dataclass
class _Member:
    key: str
    start: int
    value_start: int
    end: int


@dataclass
class _Located:
    start: int
    end: int
    # For an object: its members in order.
    members: list[_Member] | None = None


@dataclass
class _Piece:
    start: int
    end: int
    render: Callable[[], str]


@dataclass
class _ObjectEdit:
    remove: set[str] = field(default_factory=set)
    set: dict[str, str] = field(default_factory=dict)


_SPACE = re.compile(r"[ \t\n\r]*")
# The rest of a string literal after its opening quote.
_STRING_REST = re.compile(r'[^"\\]*(?:\\.[^"\\]*)*"', re.DOTALL)
# A number's characters, or a literal's letters.
_SCALAR = re.compile(r"[0-9a-zE+\-.]*")


def _segment(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def _locate(text: str, wanted: set[str]) -> dict[str, _Located]:
    """The spans of the values at ``wanted`` pointers of valid JSON ``text``, with the members of
    each object among them. A duplicate key's last member is the one a pointer names."""
    prefixes: set[str] = set()
    for pointer in wanted:
        at = len(pointer)
        while True:
            prefixes.add(pointer[:at])
            if at == 0:
                break
            at = pointer.rfind("/", 0, at)
    found: dict[str, _Located] = {}

    def space(index: int) -> int:
        match = _SPACE.match(text, index)
        return match.end() if match else index

    def string_end(index: int) -> int:
        match = _STRING_REST.match(text, index + 1)
        if match is None:
            raise ValueError("Unterminated JSON string.")
        return match.end()

    def value_end(index: int, members: list[_Member] | None = None) -> int:
        char = text[index]
        if char == '"':
            return string_end(index)
        if char in "{[":
            is_object = char == "{"
            at = space(index + 1)
            if text[at] == ("}" if is_object else "]"):
                return at + 1
            while True:
                key = ""
                start = at
                if is_object:
                    key_end = string_end(at)
                    if members is not None:
                        key = json.loads(text[at:key_end])
                    at = space(space(key_end) + 1)
                value_start = at
                end = value_end(at)
                if members is not None:
                    members.append(_Member(key, start, value_start, end))
                at = space(end)
                if text[at] == ",":
                    at = space(at + 1)
                    continue
                return at + 1
        match = _SCALAR.match(text, index)
        return match.end() if match else index

    def visit(index: int, pointer: str) -> None:
        char = text[index]
        members: list[_Member] | None = [] if char in "{[" else None
        end = value_end(index, members)
        if pointer in wanted:
            found[pointer] = _Located(index, end, members if char == "{" else None)
        if members is None:
            return
        last: dict[str, _Member] = {}
        for position, member in enumerate(members):
            last[member.key if char == "{" else str(position)] = member
        for key, member in last.items():
            child = f"{pointer}/{_segment(key)}"
            if child in prefixes:
                visit(member.value_start, child)

    try:
        visit(space(0), "")
        return found
    finally:
        # ``value_end`` and ``visit`` refer to themselves, so they outlive this call until the
        # next collection: the text they read, and what they found, are let go now.
        text, found = "", {}


def apply_json_edits(text: str, edits: Sequence[JsonEdit]) -> str:
    """``text`` with ``edits`` applied, every byte outside the changed values kept. Each object edit
    keeps the object's other members, the separators between them and its whitespace; appended
    members are written compactly (``,"key":value``) before the closing brace."""
    if not edits:
        return text
    values: dict[str, str] = {}
    objects: dict[str, _ObjectEdit] = {}
    for edit in edits:
        if edit.value is not None:
            values[edit.pointer] = edit.value
        else:
            target = objects.setdefault(edit.pointer, _ObjectEdit())
            if edit.remove is not None:
                target.remove.add(edit.remove)
            for key, value in edit.set:
                target.set[key] = value
    located = _locate(text, {*values, *objects})
    pieces: list[_Piece] = []

    def constant(value: str) -> Callable[[], str]:
        return lambda: value

    for pointer, value in values.items():
        span = located.get(pointer)
        if span is not None:
            pieces.append(_Piece(span.start, span.end, constant(value)))

    def object_render(span: _Located, edit: _ObjectEdit) -> Callable[[], str]:
        members = span.members or []
        last_of = {member.key: member for member in members}

        def build() -> str:
            kept = [member for member in members if member.key not in edit.remove]
            first = members[0].start if members else span.end - 1
            close = members[-1].end if members else span.end - 1
            out = text[span.start : first]
            for position, member in enumerate(kept):
                index = members.index(member)
                # The separator that preceded this member, comma included, unless it now comes
                # first.
                if position > 0:
                    out += text[members[index - 1].end : member.start]
                out += render(member.start, member.end)
            appended = ""
            for key, value in edit.set.items():
                if key not in last_of or key in edit.remove:
                    comma = "," if kept or appended else ""
                    appended += f"{comma}{json.dumps(key, ensure_ascii=False)}:{value}"
            return out + appended + text[close : span.end]

        return build

    for pointer, target in objects.items():
        span = located.get(pointer)
        if span is None or span.members is None:
            continue
        last_of = {member.key: member for member in span.members}
        for key, value in target.set.items():
            member = last_of.get(key)
            if member is not None and key not in target.remove:
                pieces.append(_Piece(member.value_start, member.end, constant(value)))
        pieces.append(_Piece(span.start, span.end, object_render(span, target)))
    pieces.sort(key=lambda piece: (piece.start, -piece.end))

    def render(start: int, end: int) -> str:
        """The text from ``start`` to ``end`` with the pieces within it rendered; a piece inside
        another is rendered by the outer one."""
        out: list[str] = []
        at = start
        for piece in pieces:
            if piece.start < at or piece.end > end:
                continue
            out.append(text[at : piece.start])
            out.append(piece.render())
            at = piece.end
        out.append(text[at:end])
        return "".join(out)

    try:
        return render(0, len(text))
    finally:
        # An object's piece renders through ``render``, which reads ``pieces``: emptied, that
        # cycle no longer outlives this call, with the text, until the next collection.
        pieces.clear()
