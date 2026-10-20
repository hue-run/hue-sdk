from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TypedDict

from ..client import HueSpan

Json = None | bool | int | float | str | list[Any] | dict[str, Any]
TerminalState = Literal["succeeded", "error", "cancelled"]


class Score(TypedDict, total=False):
    state: Literal["scored", "error", "skipped"]
    metrics: list[dict[str, Any]]
    explanation: str
    evidence: Json
    error: dict[str, str]


CaseFileRole = Literal[
    "source",
    "attached_template",
    "attached_reference",
    "original",
    "org_template",
    "evaluator_reference",
]


@dataclass(frozen=True)
class LocalFile:
    """A verified copy of a case's pinned input file on the runner's disk.

    ``role`` says who receives it: ``org_template`` and ``evaluator_reference`` reach only
    scorers, every other role the target as well. ``path`` holds bytes whose size and SHA-256
    the runner checked against the case's manifest.
    """

    artifact_id: str
    role: str
    filename: str
    content_type: str
    byte_size: int
    sha256: str
    path: Path


@dataclass(frozen=True)
class CaseFileWrite:
    """A pinned input file for ``EvaluationClient.add_case``.

    Either ``artifact_id``, an artifact this project already holds, or a file the client uploads
    as a verified artifact: ``filename``, ``content_type`` (one of the artifact content types)
    and exactly one of ``data`` or ``path``.
    """

    role: CaseFileRole
    artifact_id: str | None = None
    filename: str | None = None
    content_type: str | None = None
    data: bytes | None = None
    path: str | os.PathLike[str] | None = None


class ScoreContext(TypedDict, total=False):
    inputs: Json
    output: Json
    expected: Json
    has_output: bool
    has_expected: bool
    metadata: dict[str, Json]
    execution_state: TerminalState
    # Verified local copies of the case's pinned input files, present when the case has any
    # and a local code scorer runs here.
    files: list[LocalFile]


@dataclass(frozen=True)
class LocalScorer:
    """An explicit source declaration bound to trusted code in this process."""

    definition: dict[str, Any]
    score: Callable[[ScoreContext], Score | Awaitable[Score]]


@dataclass(frozen=True)
class TargetContext:
    """What a target receives besides the case inputs.

    ``files`` holds verified local copies of the case's pinned input files meant for the agent;
    organization templates and evaluator references are withheld, as in the managed protocol.
    """

    config: Json
    item: dict[str, Any]
    span: HueSpan
    files: tuple[LocalFile, ...] = ()


@dataclass(frozen=True)
class TraceEvidence:
    """``required`` completes only with an acknowledged export; ``omit`` completes without one,
    with the reason; ``pending`` completes with the trace still to arrive when the export was
    not acknowledged in time, and Hue attaches the trace once it is complete."""

    mode: Literal["required", "omit", "pending"]
    reason: str | None = None


@dataclass(frozen=True)
class RunnerReport:
    run_id: str
    subject_ids: list[str]
    result_ids: list[str]
    deferred_scorer_version_ids: list[str]
