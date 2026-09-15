"""Scenes' public portable types. No dependency on tracing or MCP globals."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ._json import canonical_json

MAX_INLINE_BYTES = 256 * 1024
MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
ABSENT = object()


class SnapshotMissError(RuntimeError):
    def __init__(self, reason: str, binding_id: str = "", operation: str = "") -> None:
        self.reason, self.binding_id, self.operation = reason, binding_id, operation
        super().__init__(f"HUE_SNAPSHOT_MISS: {reason}")


class RecordedToolError(RuntimeError):
    def __init__(self, error_type: str, *, code: Any = None) -> None:
        self.error_type, self.code = error_type, code
        super().__init__("The recorded source call raised an exception.")


class SceneTransportError(RuntimeError):
    def __init__(self, status_code: int | None = None) -> None:
        self.status_code = status_code
        super().__init__(
            "Hue Scenes request failed."
            if status_code is None
            else f"Hue Scenes request failed (HTTP {status_code})."
        )


@dataclass(frozen=True)
class Binding:
    id: str
    kind: str = "tool"
    contract_version: str = "1"
    operations: tuple[dict[str, Any], ...] = ()
    account_scope: str | None = None
    http_origin: str | None = None
    path_prefix: str = "/"
    headers: tuple[str, ...] = ()

    def wire(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "contractVersion": self.contract_version,
        }
        if self.kind not in {"tool", "mcp", "http"}:
            raise ValueError("Unsupported binding kind.")
        if any(
            not isinstance(v, str) or not 1 <= len(v) <= 128
            for v in (self.id, self.contract_version)
        ):
            raise ValueError("Binding identity and contract version must be 1–128 characters.")
        if self.operations:
            result["operations"] = list(self.operations)
        if self.account_scope is not None:
            result["accountScope"] = self.account_scope
        if self.kind == "http":
            from urllib.parse import urlsplit

            from ._json import credential_key
            from .http import safe_url

            if self.http_origin is None or not self.path_prefix.startswith("/"):
                raise ValueError("HTTP bindings require an origin and absolute path prefix.")
            origin = urlsplit(self.http_origin)
            if (
                origin.scheme not in {"http", "https"}
                or not origin.hostname
                or origin.username
                or origin.password
                or origin.query
                or origin.fragment
                or origin.path.strip("/")
            ):
                raise ValueError("Source scope must contain only an HTTP(S) origin.")
            if any(credential_key(name) for name in self.headers):
                raise ValueError("Credential headers cannot participate in source arguments.")
            result["http"] = {
                "origin": safe_url(self.http_origin).rstrip("/"),
                "pathPrefix": self.path_prefix,
                "headers": list(self.headers),
            }
        return result


@dataclass(frozen=True)
class Snapshot:
    scene_id: str
    revision: int
    digest: str

    def wire(self) -> dict[str, Any]:
        return {"sceneId": self.scene_id, "revision": self.revision, "digest": self.digest}


@dataclass(frozen=True)
class FinalizeResult:
    snapshot: Snapshot | None
    pending: int
    dropped: int
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.snapshot is not None and self.error is None


@dataclass(frozen=True)
class SourceFile:
    """Explicit observed source bytes; constructing a URI never dereferences it."""

    name: str
    data: bytes | None = field(default=None, repr=False)
    mime_type: str = "application/octet-stream"
    relation: str = "query_attachment"
    uri: str | None = None
    source_version: str | None = None
    metadata: Any = None

    @classmethod
    def from_path(cls, path: str | Path, **kwargs: Any) -> SourceFile:
        """Read only the explicitly supplied local file, up to the artifact limit."""
        with Path(path).open("rb") as source:
            data = source.read(MAX_ARTIFACT_BYTES + 1)
        if len(data) > MAX_ARTIFACT_BYTES:
            raise ValueError("Source exceeds the 25 MiB artifact limit.")
        return cls(name=Path(path).name, data=data, **kwargs)


def json_copy(value: Any) -> Any:
    import json

    return json.loads(canonical_json(value))
