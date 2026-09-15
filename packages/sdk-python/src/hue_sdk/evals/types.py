from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
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


class ScoreContext(TypedDict, total=False):
    inputs: Json
    output: Json
    expected: Json
    has_output: bool
    has_expected: bool
    metadata: dict[str, Json]
    execution_state: TerminalState


@dataclass(frozen=True)
class LocalScorer:
    """An explicit source declaration bound to trusted code in this process."""

    definition: dict[str, Any]
    score: Callable[[ScoreContext], Score | Awaitable[Score]]


@dataclass(frozen=True)
class TargetContext:
    config: Json
    item: dict[str, Any]
    span: HueSpan


@dataclass(frozen=True)
class TraceEvidence:
    mode: Literal["required", "omit"]
    reason: str | None = None


@dataclass(frozen=True)
class RunnerReport:
    run_id: str
    subject_ids: list[str]
    result_ids: list[str]
    deferred_scorer_version_ids: list[str]
