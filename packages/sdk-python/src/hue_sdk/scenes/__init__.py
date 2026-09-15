"""Optional source snapshots: explicit capture, exact recorded playback, no live fallback."""

from ._json import canonical_json, request_key
from .client import Capture, Scenes
from .playback import Recording, Replay
from .types import (
    ABSENT,
    Binding,
    FinalizeResult,
    RecordedToolError,
    SceneTransportError,
    Snapshot,
    SnapshotMissError,
    SourceFile,
)

__all__ = [
    "ABSENT",
    "Binding",
    "Capture",
    "FinalizeResult",
    "RecordedToolError",
    "Recording",
    "Replay",
    "SceneTransportError",
    "Scenes",
    "Snapshot",
    "SnapshotMissError",
    "SourceFile",
    "canonical_json",
    "request_key",
]
