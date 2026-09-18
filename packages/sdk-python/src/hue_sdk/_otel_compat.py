"""Guarded access to the two OpenTelemetry internals the transport relies on.

The OTLP log encoder and the instrumentation-suppression context key are private in
OpenTelemetry, but both have been present and unchanged in every release of the supported
range. These guards keep a future upstream change from surfacing as an opaque ``ImportError``
deep inside the exporter or as a silent behavior change in Hue's feedback protection.
"""

from __future__ import annotations

import warnings

from opentelemetry import context as otel_context
from opentelemetry.context import Context, create_key, get_value, set_value

# Keep in sync with the ``opentelemetry-*`` ranges in pyproject.toml.
SUPPORTED_OPENTELEMETRY = ">=1.40,<2"

try:
    from opentelemetry.exporter.otlp.proto.common._log_encoder import encode_logs
except ImportError as error:  # pragma: no cover - exercised through a subprocess test
    raise ImportError(
        "hue-run needs the OTLP log encoder "
        "(opentelemetry.exporter.otlp.proto.common._log_encoder.encode_logs), which the "
        "installed opentelemetry-exporter-otlp-proto-common does not provide. Install "
        f"opentelemetry-exporter-otlp-proto-http{SUPPORTED_OPENTELEMETRY} (the tested range)."
    ) from error


def _resolve_suppression_key() -> str | None:
    """Return OpenTelemetry's own suppression key, or ``None`` after a one-time warning.

    The key has to be OpenTelemetry's object: ``create_key`` values are unique per process,
    so a key synthesized by name would never match what OTel's HTTP instrumentors check.
    """
    key = getattr(otel_context, "_SUPPRESS_INSTRUMENTATION_KEY", None)
    if not isinstance(key, str):
        warnings.warn(
            "The installed opentelemetry-api does not expose _SUPPRESS_INSTRUMENTATION_KEY. "
            "Hue exports run without OpenTelemetry instrumentation suppression, so OTel HTTP "
            "instrumentors may record Hue's own export requests on other exporters. Install "
            f"opentelemetry-api{SUPPORTED_OPENTELEMETRY} (the tested range).",
            RuntimeWarning,
            stacklevel=2,
        )
        return None
    return key


SUPPRESS_INSTRUMENTATION_KEY = _resolve_suppression_key()
# Hue's own marker keeps its export path from feeding back into its own queues even when
# OpenTelemetry's key is unavailable; other exporters and instrumentors do not read it.
_HUE_EXPORT_KEY = create_key("hue-export")


def export_context(context: Context | None = None) -> Context:
    """Return ``context`` (the current one by default) marked as Hue export work."""
    marked = set_value(_HUE_EXPORT_KEY, True, context)
    if SUPPRESS_INSTRUMENTATION_KEY is not None:
        marked = set_value(SUPPRESS_INSTRUMENTATION_KEY, True, marked)
    return marked


def instrumentation_suppressed(context: Context | None = None) -> bool:
    """Whether records emitted in ``context`` come from suppressed or Hue export work."""
    if get_value(_HUE_EXPORT_KEY, context):
        return True
    return SUPPRESS_INSTRUMENTATION_KEY is not None and bool(
        get_value(SUPPRESS_INSTRUMENTATION_KEY, context)
    )


__all__ = [
    "SUPPORTED_OPENTELEMETRY",
    "SUPPRESS_INSTRUMENTATION_KEY",
    "encode_logs",
    "export_context",
    "instrumentation_suppressed",
]
