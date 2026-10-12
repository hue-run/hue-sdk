"""Files placed in recorded values: the equivalent of Langfuse's ``LangfuseMedia`` and Braintrust's
``Attachment``. Mirrors the TypeScript SDK's ``attachment.ts`` so both SDKs record the same part.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ._inline_files import inline_file, is_media_content_type, is_media_name

# Matches the 25 MiB limit of ``record_file`` data.
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
# How deep in a value an attachment's part may sit and still be uploaded: Hue reads media parts
# within ten levels of the value's root.
MAX_ATTACHMENT_DEPTH = 10
_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}\Z")


def _string_bytes(text: str) -> bytes | None:
    """A string attachment's bytes: a ``data:`` URL by its own encoding, else strict base64."""
    if text.startswith("data:"):
        decoded = inline_file(text)
        return decoded.data if decoded.decoded else None
    if len(text) % 4 or not _BASE64.match(text):
        return None
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return None


def _file_bytes(path: str | os.PathLike[str]) -> bytes | None:
    """A file's bytes, read through one descriptor and never past the limit."""
    with open(path, "rb") as file:
        if os.fstat(file.fileno()).st_size > MAX_ATTACHMENT_BYTES:
            return None
        # One byte past the limit shows a file that grew while it was read.
        data = file.read(MAX_ATTACHMENT_BYTES + 1)
    return data if len(data) <= MAX_ATTACHMENT_BYTES else None


def _attachment_bytes(data: Any, path: Any) -> bytes | None:
    if (data is None) == (path is None):
        return None
    if path is not None:
        if not isinstance(path, (str, os.PathLike)) or not os.fspath(path):
            return None
        content = _file_bytes(path)
    elif isinstance(data, str):
        if len(data) > 4 * MAX_ATTACHMENT_BYTES:
            return None
        content = _string_bytes(data)
    elif isinstance(data, (bytes, bytearray, memoryview)):
        view = memoryview(data)
        # Bytes over the limit are refused before anything is copied.
        if view.nbytes > MAX_ATTACHMENT_BYTES:
            return None
        # A copy, so a later change to the caller's buffer cannot change what the digest describes.
        content = data if type(data) is bytes else view.tobytes()
    else:
        return None
    return content if content is not None and len(content) <= MAX_ATTACHMENT_BYTES else None


class Attachment:
    """A file placed in a recorded value.

    Put it anywhere in a ``span()`` input or output, in ``model()`` messages, in a tool's
    arguments or result, in ``log_inference()`` messages, or in a span attribute passed to
    ``span(attributes=...)`` or ``set_attribute``. Hue records it at that position as a GenAI
    ``blob`` part that names the file by digest (``{"type": "blob", "mime_type", "modality",
    "sha256", "size", "name"}``) and uploads its bytes during export, listed under the record's
    ``hue.blobs``.

    Give exactly one of ``data`` (bytes, or a base64 string or ``data:`` URL holding them) and
    ``path`` (a file read now). The bytes are read and hashed when the attachment is created and
    are limited to 25 MiB. Creating one never raises: an attachment without exactly one of them,
    with unreadable data, larger data or an invalid ``content_type`` records ``None`` where it is
    placed and counts an instrumentation issue; an invalid ``name`` alone is omitted and counted.
    """

    __slots__ = ("_content_type", "_name", "_data", "_sha256", "_invalid_name")

    def __init__(
        self,
        data: bytes | bytearray | memoryview | str | None = None,
        *,
        path: str | os.PathLike[str] | None = None,
        content_type: str,
        name: str | None = None,
    ) -> None:
        content: bytes | None = None
        if is_media_content_type(content_type):
            try:
                content = _attachment_bytes(data, path)
            except (OSError, ValueError, TypeError):
                # An unreadable path: the attachment is invalid.
                content = None
        self._content_type = content_type if isinstance(content_type, str) else ""
        self._name = name if is_media_name(name) else None
        self._invalid_name = name is not None and self._name is None
        self._data = content
        self._sha256 = hashlib.sha256(content).hexdigest() if content is not None else None

    @property
    def content_type(self) -> str:
        """The media type given."""
        return self._content_type

    @property
    def name(self) -> str | None:
        """The name given, when it is a valid media name."""
        return self._name

    @property
    def sha256(self) -> str | None:
        """Lowercase hex SHA-256 of the bytes; ``None`` for an invalid attachment."""
        return self._sha256

    @property
    def size(self) -> int | None:
        """Size of the bytes; ``None`` for an invalid attachment."""
        return len(self._data) if self._data is not None else None

    def __repr__(self) -> str:
        return f"Attachment(content_type={self._content_type!r}, size={self.size!r})"


def modality_of(content_type: str) -> str:
    """The modality a media type implies, as Hue reads a part's media type."""
    mime = content_type.split(";", 1)[0].strip().lower()
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("audio/"):
        return "audio"
    if mime.startswith("video/"):
        return "video"
    if (
        mime.startswith("text/")
        or mime
        in (
            "application/pdf",
            "application/rtf",
            "application/msword",
            "application/vnd.ms-excel",
            "application/vnd.ms-powerpoint",
        )
        or mime.startswith("application/vnd.openxmlformats-officedocument.")
    ):
        return "document"
    return "file"


def attachment_part(attachment: Attachment, capture_content: bool) -> dict[str, Any] | None:
    """An attachment's digest-form GenAI part, the name only with content capture; ``None`` for
    an invalid attachment."""
    data = attachment._data
    if data is None or attachment._sha256 is None:
        return None
    part: dict[str, Any] = {
        "type": "blob",
        "mime_type": attachment._content_type,
        "modality": modality_of(attachment._content_type),
        "sha256": attachment._sha256,
        "size": len(data),
    }
    if capture_content and attachment._name is not None:
        part["name"] = attachment._name
    return part


@dataclass(frozen=True)
class PlacedAttachment:
    """One attachment as a value was copied: its part (``None`` when invalid) and its depth."""

    attachment: Attachment
    part: dict[str, Any] | None
    depth: int


def pointer_segment(segment: str) -> str:
    return segment.replace("~", "~0").replace("/", "~1")


def locate_parts(
    value: Any, attachments: list[Attachment]
) -> list[tuple[Attachment, str, str | None]]:
    """The digest parts in ``value`` (within ``MAX_ATTACHMENT_DEPTH``) that are the attachments'
    own parts: a dict with ``type`` ``blob``, no ``content``, and the attachment's ``sha256``,
    ``size`` and ``mime_type``. Each found part takes one attachment of that digest, in the
    value's order, with the ``name`` the part carries when it is valid."""
    pending = list(attachments)
    found: list[tuple[Attachment, str, str | None]] = []
    nodes = [0]

    def visit(node: Any, pointer: str, depth: int) -> None:
        nodes[0] += 1
        if not pending or depth > MAX_ATTACHMENT_DEPTH or nodes[0] > 1_048_576:
            return
        if isinstance(node, (list, tuple)):
            for index, item in enumerate(node):
                visit(item, f"{pointer}/{index}", depth + 1)
            return
        if not isinstance(node, dict):
            return
        if node.get("type") == "blob" and "content" not in node:
            for index, attachment in enumerate(pending):
                if (
                    node.get("sha256") == attachment._sha256
                    and type(node.get("size")) is int
                    and node.get("size") == attachment.size
                    and node.get("mime_type") == attachment._content_type
                ):
                    del pending[index]
                    name = node.get("name")
                    found.append((attachment, pointer, name if is_media_name(name) else None))
                    return
        for key, item in node.items():
            visit(item, f"{pointer}/{pointer_segment(str(key))}", depth + 1)

    visit(value, "", 0)
    return found


def part_at(value: Any, pointer: str) -> Any:
    """The value an RFC 6901 pointer names, or ``None``."""
    if not pointer:
        return value
    for raw in pointer[1:].split("/"):
        segment = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(value, dict):
            value = value.get(segment)
        elif isinstance(value, (list, tuple)) and segment.isdigit() and int(segment) < len(value):
            value = value[int(segment)]
        else:
            return None
    return value


def placed_part(
    file: Any, attributes: Mapping[str, Any], values: Mapping[str, Any], parsed: dict[str, Any]
) -> dict[str, Any] | None:
    """A staged attachment's own part where it was placed: at its pointer in its attribute's
    value (the value held whole for upload in ``values`` when there is one, JSON text parsed once
    into ``parsed``), with its digest and media type and no content; ``None`` when it is gone."""
    attribute, pointer = file.attribute, file.pointer
    if attribute is None or pointer is None:
        return None
    if attribute not in parsed:
        value = values[attribute] if attribute in values else attributes.get(attribute)
        try:
            parsed[attribute] = json.loads(value) if isinstance(value, (str, bytes)) else value
        except ValueError:
            parsed[attribute] = None
    part = part_at(parsed[attribute], pointer)
    if (
        isinstance(part, dict)
        and part.get("type") == "blob"
        and "content" not in part
        and part.get("sha256") == file.digest[0]
        and type(part.get("size")) is int
        and part.get("size") == file.digest[1]
        and part.get("mime_type") == file.content_type
    ):
        return part
    return None


def holds_attachment(value: Any) -> bool:
    """Whether a value holds an attachment anywhere, within the content snapshot's bounds."""
    nodes = [0]

    def visit(item: Any, depth: int) -> bool:
        if isinstance(item, Attachment):
            return True
        nodes[0] += 1
        if depth > 64 or nodes[0] > 65_536:
            return False
        if type(item) is dict:
            return any(visit(child, depth + 1) for child in item.values())
        if type(item) in (list, tuple):
            return any(visit(child, depth + 1) for child in item)
        return False

    return visit(value, 0)
