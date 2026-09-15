from __future__ import annotations

import os
import subprocess
import sys
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
    subprocess.run(
        ["uv", "pip", "install", "--python", str(python), str(next(dist.glob("*.whl")))],
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
        [str(python), "-c", "import hue_sdk; print(hue_sdk.__file__)"],
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
