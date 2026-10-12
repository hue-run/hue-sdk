"""Public local evaluation client, runner and scorer declarations."""

from ._files import CaseFileError
from ._json import MISSING
from ._media import (
    MediaClient,
    MediaFetchError,
    MediaFile,
    MediaResolveFailure,
    ResolvedMedia,
    rehydrate_media,
)
from .client import ArtifactSizeError, EvaluationClient, HueApiError, is_transient_api_error
from .runner import (
    OutcomeSerializationError,
    TelemetryExportError,
    UncertainExecutionError,
    rescore,
    run_experiment,
)
from .scorers import builtin_scorers, builtins, define_local_scorer, score_locally
from .types import (
    CaseFileWrite,
    LocalFile,
    LocalScorer,
    RunnerReport,
    Score,
    ScoreContext,
    TargetContext,
    TraceEvidence,
)

__all__ = [
    "MISSING",
    "ArtifactSizeError",
    "CaseFileError",
    "CaseFileWrite",
    "EvaluationClient",
    "HueApiError",
    "is_transient_api_error",
    "LocalFile",
    "LocalScorer",
    "MediaClient",
    "MediaFetchError",
    "MediaFile",
    "MediaResolveFailure",
    "OutcomeSerializationError",
    "ResolvedMedia",
    "RunnerReport",
    "Score",
    "ScoreContext",
    "TargetContext",
    "TelemetryExportError",
    "TraceEvidence",
    "UncertainExecutionError",
    "builtin_scorers",
    "builtins",
    "define_local_scorer",
    "rehydrate_media",
    "rescore",
    "run_experiment",
    "score_locally",
]
