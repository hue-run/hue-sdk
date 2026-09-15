from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from scenes_server import scene_server


def test_installed_wheel_records_sources_http_and_caught_miss_without_live_replay(tmp_path):
    package = Path(__file__).parents[1]
    dist, consumer = tmp_path / "dist", tmp_path / "consumer"
    subprocess.run(
        [sys.executable, "-m", "build", "--no-isolation", str(package), "--outdir", str(dist)],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["uv", "venv", str(consumer), "--python", sys.executable],
        check=True,
        capture_output=True,
        text=True,
    )
    python = consumer / "bin/python"
    wheel = next(dist.glob("*.whl"))
    subprocess.run(
        ["uv", "pip", "install", "--python", str(python), str(wheel) + "[scenes]"],
        check=True,
        capture_output=True,
        text=True,
    )
    with scene_server() as api:
        environment = {
            "PATH": os.environ["PATH"],
            "PYTHONNOUSERSITE": "1",
            "HUE_BASE_URL": api.url,
            "HUE_API_KEY": "synthetic-scenes-key",
            "HUE_SYNTHETIC_SOURCE_URL": api.source_url,
        }
        imported = subprocess.run(
            [str(python), "-c", "import hue_sdk; print(hue_sdk.__file__)"],
            cwd=tmp_path,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )
        assert str(consumer) in imported.stdout
        completed = subprocess.run(
            [str(python), str(package / "examples/scenes/main.py")],
            cwd=tmp_path,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )
        assert "playback=matched caught_misses=1 diagnostics=acknowledged" in completed.stdout
        assert environment["HUE_API_KEY"] not in completed.stdout + completed.stderr
        assert len(api.source_hits) == 2
        assert len(api.artifacts) == 2  # Captured tool JSON and explicit source bytes.
        replay = next(iter(api.replays.values()))
        assert replay["state"] == "completed"
        assert [event["status"] for event in replay["events"]] == ["matched", "matched", "miss"]
