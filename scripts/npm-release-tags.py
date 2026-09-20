"""Verify and deliberately promote Hue's immutable npm release tags."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Callable


PACKAGE = "@hue-run/sdk"
CANDIDATE_TAG = "hue-onboarding-candidate"
REGISTRY = "https://registry.npmjs.org"
STABLE_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def stable(value: str) -> str:
    if not STABLE_VERSION.fullmatch(value):
        raise ValueError("Expected an exact stable npm version")
    return value


def run_npm(args: list[str]) -> str:
    result = subprocess.run(
        ["npm", *args, f"--registry={REGISTRY}"],
        check=True,
        text=True,
        capture_output=True,
    )
    return result.stdout.strip()


def view(spec: str, field: str, runner: Callable[[list[str]], str] = run_npm) -> str:
    value = runner(["view", spec, field])
    if not value:
        raise RuntimeError(f"npm returned no {field} for {spec}")
    return value


def verify_manifest(directory: Path, version: str) -> dict:
    manifest = json.loads((directory / "release-manifest.json").read_text())
    if manifest.get("language") != "typescript" or manifest.get("version") != version:
        raise RuntimeError("Release manifest does not match the TypeScript version")
    expected = f"hue-run-sdk-{version}.tgz"
    artifacts = manifest.get("artifacts")
    if (
        not isinstance(artifacts, list)
        or len(artifacts) != 1
        or artifacts[0].get("filename") != expected
        or not re.fullmatch(r"[a-f0-9]{64}", str(artifacts[0].get("sha256", "")))
    ):
        raise RuntimeError("Release manifest has an unexpected artifact inventory")
    return manifest


def verify_acceptance_evidence(
    path: Path,
    version: str,
    manifest: dict,
    expected_latest: str,
    registry_integrity: str,
) -> None:
    value = json.loads(path.read_text())
    keys = {
        "format",
        "package",
        "sdkCommit",
        "releaseRunUrl",
        "fernCommit",
        "hostedAcceptanceRunUrl",
        "hostedEvidenceSha256",
        "servingDatabaseIdentity",
        "previousLatest",
        "productionAccepted",
    }
    if not isinstance(value, dict) or set(value) != keys or value.get("format") != 1:
        raise RuntimeError("Hosted acceptance evidence has an unexpected shape")
    artifact = manifest["artifacts"][0]
    package = value.get("package")
    if (
        not isinstance(package, dict)
        or set(package) != {"name", "version", "sha256", "integrity"}
        or package.get("name") != PACKAGE
        or package.get("version") != version
        or package.get("sha256") != artifact["sha256"]
        or package.get("integrity") != registry_integrity
    ):
        raise RuntimeError("Hosted acceptance package identity does not match the release artifact")
    if value.get("previousLatest") != expected_latest or value.get("productionAccepted") is not True:
        raise RuntimeError("Hosted acceptance did not authorize this exact latest transition")
    if value.get("sdkCommit") != manifest.get("commit"):
        raise RuntimeError("Hosted acceptance SDK commit does not match the release manifest")
    for name in ("sdkCommit", "fernCommit"):
        if not re.fullmatch(r"[a-f0-9]{40}", str(value.get(name, ""))):
            raise RuntimeError(f"Hosted acceptance has an invalid {name}")
    for name in ("releaseRunUrl", "hostedAcceptanceRunUrl"):
        if not re.fullmatch(r"https://github\.com/[^/]+/[^/]+/actions/runs/[0-9]+", str(value.get(name, ""))):
            raise RuntimeError(f"Hosted acceptance has an invalid {name}")
    if not re.fullmatch(r"[a-f0-9]{64}", str(value.get("hostedEvidenceSha256", ""))):
        raise RuntimeError("Hosted acceptance artifact hash is invalid")
    database = value.get("servingDatabaseIdentity")
    if not isinstance(database, str) or not database or len(database) > 256 or any(c.isspace() for c in database):
        raise RuntimeError("Hosted acceptance serving database identity is invalid")


def verify_registry_bytes(directory: Path, version: str) -> None:
    subprocess.run(
        [
            sys.executable,
            str(Path(__file__).with_name("release-artifacts.py")),
            "registry",
            "typescript",
            version,
            str(directory),
        ],
        check=True,
    )


def check_candidate(
    version: str,
    expected_latest: str,
    directory: Path,
    runner: Callable[[list[str]], str] = run_npm,
    registry_checker: Callable[[Path, str], None] = verify_registry_bytes,
    acceptance_evidence: Path | None = None,
) -> None:
    version = stable(version)
    expected_latest = stable(expected_latest)
    manifest = verify_manifest(directory, version)
    registry_checker(directory, version)
    candidate = view(f"{PACKAGE}@{CANDIDATE_TAG}", "version", runner)
    latest = view(f"{PACKAGE}@latest", "version", runner)
    provenance = view(f"{PACKAGE}@{version}", "dist.attestations.url", runner)
    integrity = view(f"{PACKAGE}@{version}", "dist.integrity", runner)
    if candidate != version:
        raise RuntimeError("Candidate tag does not resolve to the accepted version")
    if latest != expected_latest:
        raise RuntimeError("npm latest changed; refuse a stale promotion decision")
    if not provenance.startswith("https://"):
        raise RuntimeError("Candidate version has no npm provenance attestation")
    if not re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", integrity):
        raise RuntimeError("Candidate version has invalid npm integrity metadata")
    if acceptance_evidence is not None:
        verify_acceptance_evidence(
            acceptance_evidence,
            version,
            manifest,
            expected_latest,
            integrity,
        )


def promote(
    version: str,
    expected_latest: str,
    directory: Path,
    apply: bool,
    runner: Callable[[list[str]], str] = run_npm,
    registry_checker: Callable[[Path, str], None] = verify_registry_bytes,
    acceptance_evidence: Path | None = None,
) -> None:
    check_candidate(
        version,
        expected_latest,
        directory,
        runner,
        registry_checker,
        acceptance_evidence,
    )
    if not apply:
        print(
            f"Dry run: {PACKAGE}@{version} may replace latest {expected_latest}; "
            "no registry mutation performed."
        )
        return
    if acceptance_evidence is None:
        raise RuntimeError("--apply requires exact hosted production acceptance evidence")
    runner(["whoami"])
    runner(["dist-tag", "add", f"{PACKAGE}@{version}", "latest"])
    if view(f"{PACKAGE}@latest", "version", runner) != version:
        raise RuntimeError("npm latest promotion was not observable")
    print(f"Promoted existing {PACKAGE}@{version} bytes to latest.")


def rollback(
    from_version: str,
    to_version: str,
    apply: bool,
    runner: Callable[[list[str]], str] = run_npm,
    directory: Path | None = None,
    registry_checker: Callable[[Path, str], None] = verify_registry_bytes,
) -> None:
    from_version = stable(from_version)
    to_version = stable(to_version)
    if from_version == to_version:
        raise ValueError("Rollback versions must differ")
    if view(f"{PACKAGE}@latest", "version", runner) != from_version:
        raise RuntimeError("npm latest changed; refuse a stale rollback decision")
    if view(f"{PACKAGE}@{to_version}", "version", runner) != to_version:
        raise RuntimeError("Rollback target is not an existing immutable npm version")
    if directory is None:
        raise RuntimeError("Rollback requires the recorded previous release artifact")
    verify_manifest(directory, to_version)
    registry_checker(directory, to_version)
    if not view(f"{PACKAGE}@{to_version}", "dist.attestations.url", runner).startswith("https://"):
        raise RuntimeError("Rollback target has no npm provenance attestation")
    if not apply:
        print(
            f"Dry run: latest may roll back from {from_version} to {to_version}; "
            "no registry mutation performed."
        )
        return
    runner(["whoami"])
    runner(["dist-tag", "add", f"{PACKAGE}@{to_version}", "latest"])
    if view(f"{PACKAGE}@latest", "version", runner) != to_version:
        raise RuntimeError("npm latest rollback was not observable")
    print(f"Rolled latest back to existing {PACKAGE}@{to_version} bytes.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    promotion = subparsers.add_parser("promote")
    promotion.add_argument("--version", required=True)
    promotion.add_argument("--expected-latest", required=True)
    promotion.add_argument("--artifacts", required=True, type=Path)
    promotion.add_argument("--acceptance-evidence", type=Path)
    promotion.add_argument("--apply", action="store_true")
    rollback_parser = subparsers.add_parser("rollback")
    rollback_parser.add_argument("--from-version", required=True)
    rollback_parser.add_argument("--to-version", required=True)
    rollback_parser.add_argument("--artifacts", required=True, type=Path)
    rollback_parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.command == "promote":
        promote(
            args.version,
            args.expected_latest,
            args.artifacts,
            args.apply,
            acceptance_evidence=args.acceptance_evidence,
        )
    else:
        rollback(args.from_version, args.to_version, args.apply, directory=args.artifacts)


if __name__ == "__main__":
    main()
