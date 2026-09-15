from __future__ import annotations

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ._json import canonical_json, sha256
from .types import ABSENT, MAX_ARTIFACT_BYTES, MAX_INLINE_BYTES, SnapshotMissError


@dataclass(frozen=True)
class Blob:
    data: bytes = field(repr=False)
    encoding: str = "bytes"
    mime_type: str = "application/octet-stream"
    filename: str = "scene-payload.bin"
    purpose: str = "scene_payload"


def encode(value: Any) -> dict[str, Any]:
    if value is ABSENT:
        return {"kind": "absent"}
    if isinstance(value, bytes):
        if len(value) > MAX_ARTIFACT_BYTES:
            raise ValueError("Payload exceeds the artifact limit.")
        if 4 * ((len(value) + 2) // 3) <= MAX_INLINE_BYTES:
            return {"kind": "bytes", "base64": base64.b64encode(value).decode("ascii")}
        return {"kind": "blob", "ref": Blob(value)}
    data = canonical_json(value)
    if len(data) > MAX_ARTIFACT_BYTES:
        raise ValueError("Payload exceeds the artifact limit.")
    if len(data) <= MAX_INLINE_BYTES:
        return {"kind": "json", "value": json.loads(data)}
    return {"kind": "blob", "ref": Blob(data, "json", "application/json", "payload.json")}


def size(value: Any) -> int:
    if isinstance(value, Blob):
        return len(value.data)
    if isinstance(value, dict):
        return sum(len(key.encode("utf-8")) + size(item) for key, item in value.items()) + 2
    if isinstance(value, (tuple, list)):
        return sum(size(item) for item in value) + len(value) + 2
    return len(canonical_json(value))


def wire_size(value: Any) -> int:
    """Conservative metadata estimate before replacing local blobs with artifact references."""
    if isinstance(value, Blob):
        return 512
    if isinstance(value, dict):
        return (
            sum(len(key.encode("utf-8")) + wire_size(item) + 4 for key, item in value.items()) + 2
        )
    if isinstance(value, (tuple, list)):
        return sum(wire_size(item) for item in value) + len(value) + 2
    return len(canonical_json(value))


def materialize(value: Any, upload: Callable[[Blob], dict[str, Any]]) -> Any:
    if isinstance(value, Blob):
        return upload(value)
    if isinstance(value, list):
        return [materialize(item, upload) for item in value]
    if isinstance(value, dict):
        result = {
            key: materialize(item, upload) for key, item in value.items() if key != "_source_blob"
        }
        if "_source_blob" in value:
            result["artifactId"] = upload(value["_source_blob"])["artifactId"]
        return result
    return value


def decode(payload: dict[str, Any], download: Callable[[dict[str, Any]], bytes]) -> Any:
    kind = payload["kind"]
    if kind == "absent":
        return ABSENT
    if kind == "json":
        data = canonical_json(payload["value"])
        if len(data) > MAX_INLINE_BYTES:
            raise SnapshotMissError("integrity")
        return json.loads(data)
    if kind == "bytes":
        try:
            if len(payload["base64"]) > MAX_INLINE_BYTES:
                raise ValueError()
            return base64.b64decode(payload["base64"], validate=True)
        except ValueError:
            raise SnapshotMissError("integrity") from None
    if kind == "blob":
        ref = payload["ref"]
        if ref["byteSize"] > MAX_ARTIFACT_BYTES:
            raise SnapshotMissError("integrity")
        data = download(ref)
        if len(data) != ref["byteSize"] or sha256(data) != ref["sha256"]:
            raise SnapshotMissError("integrity")
        try:
            if ref["encoding"] == "bytes":
                return data
            if ref["encoding"] == "utf8":
                return data.decode("utf-8")
            value = json.loads(data)
            canonical_json(value)
            return value
        except (ValueError, UnicodeError):
            raise SnapshotMissError("integrity") from None
    if kind == "stream":
        # Decode before exposing any item: corrupt later blobs cannot leak partial replay.
        values = [decode(item, download) for item in payload["items"]]

        async def items():
            for value in values:
                yield value

        return items()
    if kind == "http":
        result = dict(payload)
        result["body"] = decode(payload["body"], download)
        if not isinstance(result["body"], bytes):
            raise SnapshotMissError("nonportable")
        return result
    raise SnapshotMissError("nonportable")
