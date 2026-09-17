"""Exercise an exact wheel or public registry version in fresh pip/uv consumers."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib


def run(*args: str, cwd: Path, env: dict[str, str]) -> None:
    subprocess.run(args, cwd=cwd, env=env, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--wheel", type=Path)
    source.add_argument("--registry-version")
    parser.add_argument("--python", required=True, choices=("3.10", "3.14"))
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[1]
    package = repository / "packages/sdk-python"
    version = tomllib.loads((package / "pyproject.toml").read_text())["project"][
        "version"
    ]
    if args.registry_version and args.registry_version != version:
        parser.error("Registry version must match this checkout's package version")
    environment = os.environ.copy()
    for key in ("PYTHONPATH", "HUE_API_KEY", "HUE_BASE_URL", "OPENAI_API_KEY"):
        environment.pop(key, None)
    environment["PYTHONNOUSERSITE"] = "1"
    # The evals extra provides JSON Schema scoring, which the copied behavioral suite exercises.
    spec = (
        f"{args.wheel.resolve()}[evals]"
        if args.wheel
        else f"hue-run[evals]=={args.registry_version}"
    )
    # The checkout only supplies tests and frozen test dependencies. The SDK is
    # installed separately, without an editable package or source-path fallback.
    with tempfile.TemporaryDirectory(prefix="hue-python-release-") as temporary:
        root = Path(temporary)
        requirements = root / "requirements.txt"
        run(
            "uv",
            "export",
            "--frozen",
            "--all-groups",
            "--no-emit-project",
            "--output-file",
            str(requirements),
            cwd=package,
            env=environment,
        )
        for installer in ("pip", "uv"):
            consumer = root / installer
            run(
                "uv",
                "venv",
                "--seed",
                "--python",
                args.python,
                str(consumer),
                cwd=root,
                env=environment,
            )
            python = consumer / "bin/python"
            install = (
                [str(python), "-m", "pip", "install"]
                if installer == "pip"
                else ["uv", "pip", "install", "--python", str(python)]
            )
            run(
                *install,
                "--index-url",
                "https://pypi.org/simple",
                spec,
                cwd=consumer,
                env=environment,
            )
            # Import before test extras are installed: missing runtime metadata
            # must not be concealed by dependencies from the development lockfile.
            run(
                str(python),
                "-c",
                "import hue_sdk, hue_sdk.evals, pathlib, sys; from importlib.metadata import version; "
                "assert pathlib.Path(hue_sdk.__file__).is_relative_to(sys.prefix); "
                "assert version('hue-run') == sys.argv[1]",
                version,
                cwd=consumer,
                env=environment,
            )
            run(
                *install,
                "--index-url",
                "https://pypi.org/simple",
                "-r",
                str(requirements),
                cwd=consumer,
                env=environment,
            )
            shutil.copytree(
                package / "tests",
                consumer / "tests",
                ignore=shutil.ignore_patterns("__pycache__", "test_wheel.py"),
            )
            # These two source-suite cases rebuild wheels. All other behavior,
            # including evaluations/schema subprocesses, uses the installed SDK.
            run(
                str(python),
                "-m",
                "pytest",
                "-q",
                "tests",
                "--basetemp",
                str(consumer / "test-results"),
                "-k",
                "not installed_wheel",
                cwd=consumer,
                env=environment,
            )
            print(
                f"Verified {spec} with {installer} on Python {args.python}", flush=True
            )
            # Keep peak disk use to one installed consumer; no test environment is
            # reused across installers and pytest output remains in the run log.
            shutil.rmtree(consumer)


if __name__ == "__main__":
    main()
