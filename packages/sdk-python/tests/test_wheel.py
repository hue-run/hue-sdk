from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path


def test_installed_wheel_runs_standalone_stream_tool_error(receiver, tmp_path):
    package = Path(__file__).resolve().parents[1]
    repository = package.parents[1]
    dist = tmp_path / "dist"
    consumer = tmp_path / "consumer"
    for command in (
        [sys.executable, "-m", "build", "--no-isolation", str(package), "--outdir", str(dist)],
        ["uv", "venv", str(consumer), "--python", sys.executable],
    ):
        subprocess.run(command, check=True, capture_output=True, text=True)
    python = consumer / "bin" / "python"
    # Install the wheel against the OpenTelemetry release under test so the installed-package
    # check certifies the same combination as the in-process suite (including the CI job that
    # resolves every direct dependency at its declared floor).
    opentelemetry = [
        f"{name}=={version(name)}"
        for name in (
            "opentelemetry-api",
            "opentelemetry-sdk",
            "opentelemetry-exporter-otlp-proto-http",
        )
    ]
    subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(python),
            f"{next(dist.glob('*.whl'))}[evals]",
            *opentelemetry,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    environment = {
        "PATH": os.environ["PATH"],
        "PYTHONNOUSERSITE": "1",
        "HUE_BASE_URL": receiver.url,
        "HUE_API_KEY": "synthetic-installed-wheel-key",
    }
    imported = subprocess.run(
        [
            str(python),
            "-c",
            "import hue_sdk; from importlib.metadata import version; "
            "assert version('hue-run') == hue_sdk.__version__; print(hue_sdk.__file__)",
        ],
        env=environment,
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )
    assert str(consumer) in imported.stdout
    for capture in ("yes", "no"):
        offset = len(receiver.requests)
        completed = subprocess.run(
            [
                str(python),
                str(repository / "examples/python-agent/main.py"),
                "--capture-content",
                capture,
            ],
            env=environment,
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        )
        assert "mode=synthetic" in completed.stdout and "exported=true" in completed.stdout
        assert environment["HUE_API_KEY"] not in completed.stdout + completed.stderr
        if capture == "no":
            payload = b"".join(body for _, _, body in receiver.requests[offset:])
            assert b"Double 10.5" not in payload
            assert b"The synthetic " not in payload
    spans = receiver.spans()
    assert len(spans) == 8  # Four spans for each capture mode.
    assert len(receiver.logs()) == 2
    assert len([span for span in spans if span.status.code == 2]) == 2
    assert (
        len([event for span in spans for event in span.events if event.name == "stream.chunk"]) == 6
    )
    assert all(span.trace_id for span in spans)

    trace_id = spans[0].trace_id.hex()
    span_id = spans[0].span_id.hex()
    receiver.reply(404, json.dumps({"code": "TRACE_NOT_FOUND"}).encode())
    receiver.reply(
        200,
        json.dumps(
            {
                "traceId": trace_id,
                "spanCount": 1,
                "revision": 1,
                "fields": dict.fromkeys(("input", "output", "model", "usage", "session"), False),
                "matchedSpanIds": [span_id],
                "missingSpanIds": [],
                "traceUrl": f"{receiver.url}/projects/synthetic/traces/{trace_id}",
            }
        ).encode(),
    )
    confirmation = subprocess.run(
        [
            str(python),
            "-c",
            """
import os
import sys
from hue_sdk import Hue, TraceReceipt, TraceVerificationResult, TraceVerificationError
with Hue(os.environ['HUE_BASE_URL'], os.environ['HUE_API_KEY'], capture_content=False) as hue:
    result = hue.verify_trace(sys.argv[1], expected_span_ids=[sys.argv[2]], timeout_millis=2000)
    assert isinstance(result, TraceVerificationResult) and result.verified
    assert isinstance(result.receipt, TraceReceipt)
    assert result.receipt.matched_span_ids == (sys.argv[2],)
    print('receipt-verified=true')
""",
            trace_id,
            span_id,
        ],
        env=environment,
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )
    assert "receipt-verified=true" in confirmation.stdout
    assert environment["HUE_API_KEY"] not in confirmation.stdout + confirmation.stderr

    # Exercise failure boundaries against this wheel too: the copied tests run
    # outside the checkout, with no editable package or source-path fallback.
    subprocess.run(
        ["uv", "pip", "install", "--python", str(python), f"pytest=={version('pytest')}"],
        check=True,
        capture_output=True,
        text=True,
    )
    receipt_tests = tmp_path / "receipt-tests"
    receipt_tests.mkdir()
    for name in ("conftest.py", "test_receipts.py", "test_isolation.py"):
        shutil.copyfile(package / "tests" / name, receipt_tests / name)
    subprocess.run(
        [str(python), "-m", "pytest", "-q", str(receipt_tests)],
        env=environment,
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )


def test_installed_wheel_managed_target_boundaries(tmp_path):
    package = Path(__file__).resolve().parents[1]
    dist = tmp_path / "dist"
    consumer = tmp_path / "consumer"
    for command in (
        [sys.executable, "-m", "build", "--no-isolation", str(package), "--outdir", str(dist)],
        ["uv", "venv", str(consumer), "--python", sys.executable],
    ):
        subprocess.run(command, check=True, capture_output=True, text=True)
    python = consumer / "bin" / "python"
    subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(python),
            f"{next(dist.glob('*.whl'))}[evals]",
            "pytest>=8.3,<10",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    shutil.copyfile(package / "tests/test_managed.py", tmp_path / "test_managed.py")
    subprocess.run(
        [str(python), "-m", "pytest", "-q", "test_managed.py"],
        env={"PATH": os.environ["PATH"], "PYTHONNOUSERSITE": "1"},
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )
