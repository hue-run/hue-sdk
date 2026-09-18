"""The two OpenTelemetry internals Hue relies on are guarded, not assumed."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import textwrap
from importlib.metadata import requires
from pathlib import Path

from opentelemetry.context import (
    _SUPPRESS_INSTRUMENTATION_KEY,
    attach,
    detach,
    get_value,
    set_value,
)

from hue_sdk import _otel_compat

# OpenTelemetry's own SDK modules bind the suppression key at import time. Import them before
# removing the key so only Hue's import path sees an opentelemetry-api release without it.
WARM_UP = """
import opentelemetry.sdk.trace.export
import opentelemetry.sdk._logs.export
import opentelemetry.exporter.otlp.proto.http.trace_exporter
import opentelemetry.exporter.otlp.proto.http._log_exporter
"""


def _run(script: str, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        env={"PATH": os.environ["PATH"], "PYTHONNOUSERSITE": "1", **env},
        capture_output=True,
        text=True,
    )


def test_export_context_marks_hue_work_and_otel_suppression():
    assert _otel_compat.SUPPRESS_INSTRUMENTATION_KEY == _SUPPRESS_INSTRUMENTATION_KEY
    assert not _otel_compat.instrumentation_suppressed()
    token = attach(_otel_compat.export_context())
    try:
        assert _otel_compat.instrumentation_suppressed()
        assert get_value(_SUPPRESS_INSTRUMENTATION_KEY) is True
    finally:
        detach(token)
    assert not _otel_compat.instrumentation_suppressed()
    # Another exporter's suppressed scope is honored as well.
    assert _otel_compat.instrumentation_suppressed(set_value(_SUPPRESS_INSTRUMENTATION_KEY, True))


def test_missing_log_encoder_raises_an_import_error_naming_the_supported_range():
    completed = _run(
        """
        import sys

        sys.modules["opentelemetry.exporter.otlp.proto.common._log_encoder"] = None
        import hue_sdk
        """
    )
    assert completed.returncode != 0
    assert "ImportError" in completed.stderr
    assert "encode_logs" in completed.stderr
    assert f"opentelemetry-exporter-otlp-proto-http{_otel_compat.SUPPORTED_OPENTELEMETRY}" in (
        completed.stderr
    )


def test_missing_suppression_key_warns_once_and_still_exports(receiver):
    completed = _run(
        WARM_UP
        + textwrap.dedent("""
        import os
        import warnings

        import opentelemetry.context

        del opentelemetry.context._SUPPRESS_INSTRUMENTATION_KEY
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            from hue_sdk import Hue, _otel_compat
        runtime = [str(w.message) for w in caught if issubclass(w.category, RuntimeWarning)]
        assert len(runtime) == 1, runtime
        assert "opentelemetry-api>=1.40,<2" in runtime[0], runtime
        assert _otel_compat.SUPPRESS_INSTRUMENTATION_KEY is None

        from opentelemetry.context import attach, detach

        assert not _otel_compat.instrumentation_suppressed()
        token = attach(_otel_compat.export_context())
        assert _otel_compat.instrumentation_suppressed()  # Hue's own marker still applies.
        detach(token)
        hue = Hue(os.environ["HUE_BASE_URL"], os.environ["HUE_API_KEY"], capture_content=False)
        with hue:
            with hue.span("fallback-export"):
                pass
            assert hue.force_flush(timeout_millis=5000)
            assert hue.export_status.ok
        print("fallback-export=ok")
        """),
        HUE_BASE_URL=receiver.url,
        HUE_API_KEY="synthetic-compat-key",
    )
    assert completed.returncode == 0, completed.stderr
    assert "fallback-export=ok" in completed.stdout
    assert "synthetic-compat-key" not in completed.stdout + completed.stderr
    assert [span.name for span in receiver.spans()] == ["fallback-export"]


def _specifier_clauses(spec: str) -> frozenset[str]:
    return frozenset(part.strip() for part in spec.split(",") if part.strip())


def test_supported_range_matches_package_metadata() -> None:
    """The ImportError text, installed metadata, and pyproject.toml (when present) agree."""
    # Release verification copies only this tests/ tree into a fresh venv. Hatchling
    # normalizes `>=1.40,<2` to `<2,>=1.40` in Requires-Dist, so compare clause sets.
    expected = _specifier_clauses(_otel_compat.SUPPORTED_OPENTELEMETRY)
    specifiers: dict[str, frozenset[str]] = {}
    for requirement in requires("hue-run") or []:
        name_and_spec = requirement.split(";", 1)[0].strip()
        match = re.fullmatch(r"(opentelemetry-[a-z-]+)(.+)", name_and_spec)
        if match:
            specifiers[match.group(1)] = _specifier_clauses(match.group(2))
    assert specifiers, "expected opentelemetry dependencies in hue-run metadata"
    assert set(specifiers.values()) == {expected}

    # Parsed with a regex rather than tomllib so the extra source-tree check also
    # runs on Python 3.10. Skip the file when tests are copied without pyproject.toml.
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    if not pyproject.is_file():
        return
    from_file = dict(
        re.findall(r'^\s*"(opentelemetry-[a-z-]+)(>=[^"]+)",?$', pyproject.read_text(), re.M)
    )
    assert from_file, "expected opentelemetry dependencies in pyproject.toml"
    assert set(from_file.values()) == {_otel_compat.SUPPORTED_OPENTELEMETRY}
