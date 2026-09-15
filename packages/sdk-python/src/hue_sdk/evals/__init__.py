"""Public local evaluation client, runner and scorer declarations."""

from ._json import MISSING
from .client import EvaluationClient, HueApiError
from .runner import (
    OutcomeSerializationError,
    TelemetryExportError,
    UncertainExecutionError,
    rescore,
    run_experiment,
)
from .scorers import builtins, define_local_scorer, score_locally
from .types import LocalScorer, RunnerReport, Score, ScoreContext, TargetContext, TraceEvidence

__all__ = [
    "MISSING",
    "EvaluationClient",
    "HueApiError",
    "LocalScorer",
    "OutcomeSerializationError",
    "RunnerReport",
    "Score",
    "ScoreContext",
    "TargetContext",
    "TelemetryExportError",
    "TraceEvidence",
    "UncertainExecutionError",
    "builtins",
    "define_local_scorer",
    "rescore",
    "run_experiment",
    "score_locally",
]
