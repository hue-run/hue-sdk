"""Bounded World preparation progress; unrelated response content is discarded."""

from __future__ import annotations

from typing import Any, Literal, TypedDict

WorldPreparationState = Literal[
    "preparing", "insufficient_evidence", "processing_limit", "dependency_unavailable", "ready"
]


class WorldPreparationProgress(TypedDict):
    state: WorldPreparationState
    selectedEvidenceCutoff: int
    retainedEvidenceCutoff: int
    readyEvidenceCutoff: int
    pendingEvidence: bool


class WorldModelProcessing(TypedDict):
    state: Literal[
        "indexed",
        "preparing",
        "insufficient_evidence",
        "processing_limit",
        "dependency_unavailable",
    ]
    retainedEvidenceCutoff: int
    readyEvidenceCutoff: int
    pendingEvidence: bool


PREPARATION_DIAGNOSTICS: dict[str, WorldPreparationState] = {
    "world_preparing": "preparing",
    "world_insufficient_evidence": "insufficient_evidence",
    "world_processing_limit": "processing_limit",
    "world_dependency_unavailable": "dependency_unavailable",
}
TERMINAL_WORLD_DIAGNOSTICS = frozenset({"world_insufficient_evidence", "world_processing_limit"})


def parse_preparation(body: Any, diagnostic: str | None) -> WorldPreparationProgress | None:
    state = PREPARATION_DIAGNOSTICS.get(diagnostic or "")
    if state is None or not isinstance(body, dict):
        return None
    value = body.get("preparation")
    if not isinstance(value, dict) or value.get("state") != state:
        return None
    keys = ("selectedEvidenceCutoff", "retainedEvidenceCutoff", "readyEvidenceCutoff")
    if any(type(value.get(key)) is not int or not 0 <= value[key] <= 2**53 - 1 for key in keys):
        return None
    selected, retained, ready = (value[key] for key in keys)
    if selected > retained or ready > retained:
        return None
    pending = value.get("pendingEvidence")
    if type(pending) is not bool or pending != (retained > ready):
        return None
    return {
        "state": state,
        "selectedEvidenceCutoff": selected,
        "retainedEvidenceCutoff": retained,
        "readyEvidenceCutoff": ready,
        "pendingEvidence": pending,
    }
