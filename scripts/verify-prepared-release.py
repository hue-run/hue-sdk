"""Validate a same-commit, prepare-only Actions archive before immutable reuse."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess

REPOSITORY = "hue-run/hue-sdk"


def github(path: str):
    result = subprocess.run(
        ["gh", "api", f"repos/{REPOSITORY}/{path}"],
        check=False, capture_output=True, text=True, timeout=30,
    )
    if result.returncode or len(result.stdout) > 2_000_000:
        raise RuntimeError("Unable to verify the prepared release Actions identity")
    return json.loads(result.stdout)


def validate_run(run: dict, jobs: dict, commit: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Expected an immutable commit")
    if any(run.get(key) != value for key, value in {
        "head_sha": commit, "head_branch": "main", "event": "workflow_dispatch",
        "status": "completed", "conclusion": "success", "path": ".github/workflows/release.yml",
    }.items()) or run.get("repository", {}).get("full_name") != REPOSITORY:
        raise ValueError("Prepared run must be a successful same-commit main Release SDK run")
    items = jobs.get("jobs")
    if not isinstance(items, list) or jobs.get("total_count") != len(items):
        raise ValueError("Incomplete release job inventory")
    for name, conclusion in (("prepare", "success"), ("publish-npm", "skipped"), ("publish-pypi", "skipped")):
        matches = [item for item in items if item.get("name") == name]
        if len(matches) != 1 or matches[0].get("conclusion") != conclusion:
            raise ValueError("Only a verified prepare-only run may supply release bytes")


def validate_archive(directory: Path, commit: str, version: str) -> None:
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Expected an exact stable version")
    manifest = json.loads((directory / "release-manifest.json").read_text())
    if any(manifest.get(key) != value for key, value in {
        "commit": commit, "language": "typescript", "version": version,
    }.items()):
        raise ValueError("Prepared release manifest identity does not match")
    filename = f"hue-run-sdk-{version}.tgz"
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 1 or artifacts[0].get("filename") != filename:
        raise ValueError("Unexpected prepared archive inventory")
    path = directory / filename
    if path.is_symlink() or not path.is_file():
        raise ValueError("Unsafe prepared archive")
    if artifacts[0].get("sha256") != hashlib.sha256(path.read_bytes()).hexdigest():
        raise ValueError("Prepared archive bytes changed")
    if artifacts[0].get("integrity") != "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode("ascii"):
        raise ValueError("Prepared archive integrity changed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[1-9][0-9]{0,19}", args.run_id):
        raise ValueError("Expected a numeric prepared Actions run id")
    validate_run(github(f"actions/runs/{args.run_id}"),
                 github(f"actions/runs/{args.run_id}/jobs?per_page=100"), args.commit)
    if args.artifacts:
        validate_archive(args.artifacts, args.commit, args.version)
    print("Verified prepare-only release identity; no package rebuilt or published.")


if __name__ == "__main__":
    main()
