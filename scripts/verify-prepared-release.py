"""Validate a same-commit, prepare-only Actions archive before immutable reuse."""

from __future__ import annotations

import argparse
import base64
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import stat
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
    filename = f"hue-run-sdk-{version}.tgz"
    expected = {filename, "release-manifest.json", "SHA256SUMS"}
    try:
        with ExitStack() as stack:
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            stack.callback(os.close, directory_fd)
            directory_stat = os.fstat(directory_fd)
            if set(os.listdir(directory_fd)) != expected:
                raise ValueError("Unexpected prepared artifact directory inventory")
            opened = {}
            for name in expected:
                descriptor = os.open(
                    name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd
                )
                handle = stack.enter_context(os.fdopen(descriptor, "rb"))
                original = os.fstat(handle.fileno())
                if not stat.S_ISREG(original.st_mode):
                    raise ValueError("Prepared artifacts must be regular non-symlink files")
                opened[name] = (handle, original)
            metadata = {}
            for name in ("release-manifest.json", "SHA256SUMS"):
                data = opened[name][0].read(32_769)
                if len(data) > 32_768:
                    raise ValueError("Prepared artifact metadata is oversized")
                metadata[name] = data
            sha256, sha512 = hashlib.sha256(), hashlib.sha512()
            while chunk := opened[filename][0].read(1024 * 1024):
                sha256.update(chunk)
                sha512.update(chunk)
            for name, (handle, original) in opened.items():
                for current in (
                    os.fstat(handle.fileno()),
                    os.stat(name, dir_fd=directory_fd, follow_symlinks=False),
                ):
                    if any(
                        getattr(original, field) != getattr(current, field)
                        for field in ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns")
                    ):
                        raise ValueError("Prepared artifacts changed during verification")
            current_directory = os.stat(directory, follow_symlinks=False)
            if (
                set(os.listdir(directory_fd)) != expected
                or (directory_stat.st_dev, directory_stat.st_ino, directory_stat.st_mode)
                != (current_directory.st_dev, current_directory.st_ino, current_directory.st_mode)
            ):
                raise ValueError("Prepared artifact directory changed during verification")
    except OSError:
        raise ValueError("Unsafe or missing prepared artifact") from None
    manifest = json.loads(metadata["release-manifest.json"])
    if not isinstance(manifest, dict) or set(manifest) != {
        "commit", "language", "version", "artifacts"
    } or any(manifest.get(key) != value for key, value in {
        "commit": commit, "language": "typescript", "version": version,
    }.items()):
        raise ValueError("Prepared release manifest identity does not match")
    artifacts = manifest.get("artifacts")
    if (
        not isinstance(artifacts, list) or len(artifacts) != 1
        or not isinstance(artifacts[0], dict)
        or set(artifacts[0]) != {"filename", "sha256", "integrity"}
        or artifacts[0].get("filename") != filename
    ):
        raise ValueError("Unexpected prepared archive inventory")
    if artifacts[0].get("sha256") != sha256.hexdigest():
        raise ValueError("Prepared archive bytes changed")
    if artifacts[0].get("integrity") != "sha512-" + base64.b64encode(sha512.digest()).decode("ascii"):
        raise ValueError("Prepared archive integrity changed")
    if metadata["SHA256SUMS"] != f"{sha256.hexdigest()}  {filename}\n".encode("ascii"):
        raise ValueError("Prepared archive checksum inventory does not match")


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
