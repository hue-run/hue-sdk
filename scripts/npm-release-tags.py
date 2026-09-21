"""Verify and deliberately promote Hue's immutable npm release tags."""

from __future__ import annotations

import argparse
import base64
import fcntl
import getpass
import hashlib
import json
import os
import re
import selectors
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path

PACKAGE = "@hue-run/sdk"
CANDIDATE_TAG = "hue-onboarding-candidate"
REGISTRY = "https://registry.npmjs.org"
STABLE_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
MAX_OUTPUT_BYTES = 64 * 1024
COMMAND_TIMEOUT_SECONDS = 120


def bounded_command(command: list[str], environment: dict | None = None) -> str:
    """Bound time/memory and never expose child payloads, commands or tracebacks."""
    child = None
    try:
        child = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        output = bytearray()
        total = 0
        deadline = time.monotonic() + COMMAND_TIMEOUT_SECONDS
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, True)
            selector.register(child.stderr, selectors.EVENT_READ, False)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Registry command exceeded its deadline")
                for key, _ in selector.select(min(remaining, 1)):
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    if total > MAX_OUTPUT_BYTES:
                        raise RuntimeError("Registry command exceeded its output limit")
                    if key.data:
                        output.extend(chunk)
            if child.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
                raise RuntimeError("Registry command failed")
        return output.decode("utf-8", errors="strict").strip()
    except (OSError, UnicodeError, RuntimeError, subprocess.TimeoutExpired):
        raise RuntimeError(
            "Registry command failed; private output was suppressed"
        ) from None
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
                child.wait()
            if child.stdout:
                child.stdout.close()
            if child.stderr:
                child.stderr.close()


def lock_path() -> Path:
    return Path(tempfile.gettempdir()).resolve() / f"hue-npm-tags-{os.getuid()}.lock"


@contextmanager
def tag_lock():
    """Serialize this maintainer's local tag operations; npm has no cross-host CAS."""
    descriptor = os.open(lock_path(), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
        ):
            raise RuntimeError("Unsafe local release lock")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(
                "Another local release-tag operation is in progress"
            ) from None
        yield
    finally:
        os.close(descriptor)


def read_json(path: Path) -> dict:
    with path.open("rb") as source:
        data = source.read(32 * 1024 + 1)
    if len(data) > 32 * 1024:
        raise RuntimeError("Release evidence exceeds its size limit")
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError):
        raise RuntimeError("Release evidence is not valid JSON") from None
    if not isinstance(value, dict):
        raise TypeError("Release evidence must be an object")
    return value


def contains_secret(value: object) -> bool:
    text = json.dumps(value)
    return bool(
        re.search(
            r"hue_(?:sk|setup|install|claim)_|/setup/claim|"
            r"(?:cookie|authorization|claimSecret|claimToken|apiKey|verificationUrl)\s*[\"']?\s*:",
            text,
            re.IGNORECASE,
        )
    )


def stable(value: str) -> str:
    if not STABLE_VERSION.fullmatch(value):
        raise ValueError("Expected an exact stable npm version")
    return value


def matches(pattern: str, value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def run_npm(args: list[str], otp: str | None = None) -> str:
    environment = os.environ.copy()
    if otp is not None:
        environment["npm_config_otp"] = otp
    return bounded_command(
        [
            "npm",
            *args,
            f"--registry={REGISTRY}",
            "--loglevel=silent",
            "--logs-max=0",
            "--fetch-retries=0",
            "--fetch-timeout=30000",
        ],
        environment,
    )


def view(spec: str, field: str, runner: Callable[[list[str]], str] = run_npm) -> str:
    value = runner(["view", spec, field])
    if not value:
        raise RuntimeError(f"npm returned no {field} for {spec}")
    return value


def verify_manifest(directory: Path, version: str) -> dict:
    manifest = read_json(directory / "release-manifest.json")
    if set(manifest) != {
        "commit",
        "language",
        "version",
        "artifacts",
    } or not matches(r"[a-f0-9]{40}", manifest.get("commit")):
        raise RuntimeError("Release manifest has an unexpected shape")
    if manifest.get("language") != "typescript" or manifest.get("version") != version:
        raise RuntimeError("Release manifest does not match the TypeScript version")
    expected = f"hue-run-sdk-{version}.tgz"
    artifacts = manifest.get("artifacts")
    if (
        not isinstance(artifacts, list)
        or len(artifacts) != 1
        or not isinstance(artifacts[0], dict)
        or set(artifacts[0])
        not in ({"filename", "sha256"}, {"filename", "sha256", "integrity"})
        or artifacts[0].get("filename") != expected
        or not matches(r"[a-f0-9]{64}", artifacts[0].get("sha256"))
    ):
        raise RuntimeError("Release manifest has an unexpected artifact inventory")
    if (
        hashlib.sha256((directory / expected).read_bytes()).hexdigest()
        != artifacts[0]["sha256"]
    ):
        raise RuntimeError("Local archive bytes differ from the release manifest")
    integrity = "sha512-" + base64.b64encode(
        hashlib.sha512((directory / expected).read_bytes()).digest()
    ).decode("ascii")
    if (version == "0.4.0" or "integrity" in artifacts[0]) and artifacts[0].get(
        "integrity"
    ) != integrity:
        raise RuntimeError("Local archive integrity differs from the release manifest")
    return manifest


def verify_acceptance_evidence(
    path: Path,
    version: str,
    manifest: dict,
    expected_latest: str,
    registry_integrity: str,
) -> str:
    value = read_json(path)
    if contains_secret(value):
        raise RuntimeError("Private material is forbidden in release evidence")
    keys = {
        "format",
        "package",
        "sdkCommit",
        "releaseRunUrl",
        "fernCommit",
        "hostedAcceptanceRunUrl",
        "hostedEvidenceSha256",
        "servingDatabaseIdentity",
        "servingDatabaseIdentityTuple",
        "servingArtifactSha256",
        "previousLatest",
        "productionAccepted",
    }
    if (
        set(value) != keys
        or type(value.get("format")) is not int
        or value.get("format") != 1
    ):
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
        raise RuntimeError(
            "Hosted acceptance package identity does not match the release artifact"
        )
    if (
        value.get("previousLatest") != expected_latest
        or value.get("productionAccepted") is not True
    ):
        raise RuntimeError(
            "Hosted acceptance did not authorize this exact latest transition"
        )
    if value.get("sdkCommit") != manifest.get("commit"):
        raise RuntimeError(
            "Hosted acceptance SDK commit does not match the release manifest"
        )
    for name in ("sdkCommit", "fernCommit"):
        if not matches(r"[a-f0-9]{40}", value.get(name)):
            raise RuntimeError(f"Hosted acceptance has an invalid {name}")
    for name, repository in (
        ("releaseRunUrl", "hue-sdk"),
        ("hostedAcceptanceRunUrl", "fern"),
    ):
        if not matches(
            rf"https://github\.com/hue-run/{repository}/actions/runs/[1-9][0-9]*",
            value.get(name),
        ):
            raise RuntimeError(f"Hosted acceptance has an invalid {name}")
    for name in ("hostedEvidenceSha256", "servingArtifactSha256"):
        if not matches(r"[a-f0-9]{64}", value.get(name)):
            raise RuntimeError("Hosted acceptance artifact hash is invalid")
    database = value.get("servingDatabaseIdentity")
    identity_tuple = value.get("servingDatabaseIdentityTuple")
    if (
        not isinstance(identity_tuple, dict)
        or set(identity_tuple)
        != {"provider", "environment", "projectRef", "database", "migrationDigest"}
        or identity_tuple.get("provider") != "supabase"
        or identity_tuple.get("environment") != "production"
        or identity_tuple.get("database") != "postgres"
        or not matches(r"[a-z]{20}", identity_tuple.get("projectRef"))
        or not matches(r"[a-f0-9]{64}", identity_tuple.get("migrationDigest"))
    ):
        raise RuntimeError("Hosted acceptance serving database tuple is invalid")
    canonical = {
        name: identity_tuple[name]
        for name in (
            "provider",
            "environment",
            "projectRef",
            "database",
            "migrationDigest",
        )
    }
    expected_database = (
        "sha256:"
        + hashlib.sha256(
            json.dumps(canonical, separators=(",", ":"), ensure_ascii=False).encode(
                "utf-8"
            )
        ).hexdigest()
    )
    if database != expected_database:
        raise RuntimeError("Hosted acceptance serving database identity is invalid")
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode("utf-8")).hexdigest()


def verify_registry_bytes(directory: Path, version: str) -> None:
    bounded_command(
        [
            sys.executable,
            str(Path(__file__).with_name("release-artifacts.py")),
            "registry",
            "typescript",
            version,
            str(directory),
        ],
    )


def registry_identity(
    directory: Path, version: str, runner: Callable[[list[str]], str]
) -> tuple[str, str]:
    if view(f"{PACKAGE}@{version}", "version", runner) != version:
        raise RuntimeError(
            "Registry version differs from the immutable release version"
        )
    provenance = view(f"{PACKAGE}@{version}", "dist.attestations.url", runner)
    if provenance != f"{REGISTRY}/-/npm/v1/attestations/@hue-run%2fsdk@{version}":
        raise RuntimeError("Release has no canonical npm provenance attestation")
    integrity = view(f"{PACKAGE}@{version}", "dist.integrity", runner)
    expected = "sha512-" + base64.b64encode(
        hashlib.sha512((directory / f"hue-run-sdk-{version}.tgz").read_bytes()).digest()
    ).decode("ascii")
    if integrity != expected:
        raise RuntimeError("Registry integrity differs from the exact local archive")
    return integrity, provenance


def check_candidate(
    version: str,
    expected_latest: str,
    directory: Path,
    runner: Callable[[list[str]], str] = run_npm,
    registry_checker: Callable[[Path, str], None] = verify_registry_bytes,
    acceptance_evidence: Path | None = None,
) -> tuple[str, str, str | None]:
    version = stable(version)
    expected_latest = stable(expected_latest)
    manifest = verify_manifest(directory, version)
    registry_checker(directory, version)
    candidate = view(f"{PACKAGE}@{CANDIDATE_TAG}", "version", runner)
    integrity, provenance = registry_identity(directory, version, runner)
    if candidate != version:
        raise RuntimeError("Candidate tag does not resolve to the accepted version")
    evidence_digest = None
    if acceptance_evidence is not None:
        evidence_digest = verify_acceptance_evidence(
            acceptance_evidence,
            version,
            manifest,
            expected_latest,
            integrity,
        )
    if view(f"{PACKAGE}@latest", "version", runner) != expected_latest:
        raise RuntimeError("npm latest changed; refuse a stale promotion decision")
    return integrity, provenance, evidence_digest


def authenticate(
    runner: Callable[[list[str]], str], otp_provider: Callable[[], str] | None
) -> str | None:
    account = runner(["whoami"])
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,214}", account) or contains_secret(account):
        raise RuntimeError("An authenticated npm maintainer session is required")
    if otp_provider is None:
        return None
    otp = otp_provider()
    if not re.fullmatch(r"[0-9]{6,8}", otp):
        raise RuntimeError("Invalid npm one-time password")
    return otp


def mutate_tag(
    version: str, runner: Callable[[list[str]], str], otp: str | None
) -> None:
    args = ["dist-tag", "add", f"{PACKAGE}@{version}", "latest"]
    try:
        if runner is run_npm:
            run_npm(args, otp=otp)
        else:
            runner(args)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        raise RuntimeError(
            "Tag mutation was not confirmed; inspect registry state before any retry"
        ) from None


def verify_promoted(
    directory: Path,
    version: str,
    identity: tuple[str, str],
    runner: Callable[[list[str]], str],
    registry_checker: Callable[[Path, str], None],
) -> None:
    verify_manifest(directory, version)
    registry_checker(directory, version)
    if registry_identity(directory, version, runner) != identity:
        raise RuntimeError(
            "Registry identity changed after tag mutation; operator recovery required"
        )
    if view(f"{PACKAGE}@latest", "version", runner) != version:
        raise RuntimeError(
            "npm latest transition was not observable; operator recovery required"
        )


def promote(
    version: str,
    expected_latest: str,
    directory: Path,
    apply: bool,
    runner: Callable[[list[str]], str] = run_npm,
    registry_checker: Callable[[Path, str], None] = verify_registry_bytes,
    acceptance_evidence: Path | None = None,
    otp_provider: Callable[[], str] | None = None,
) -> None:
    with tag_lock():
        identity = check_candidate(
            version,
            expected_latest,
            directory,
            runner,
            registry_checker,
            acceptance_evidence,
        )
        if not apply:
            print(
                f"Dry run: {PACKAGE}@{version} may replace latest {expected_latest}; no registry mutation performed."
            )
            return
        if acceptance_evidence is None:
            raise RuntimeError(
                "--apply requires exact hosted production acceptance evidence"
            )
        otp = authenticate(runner, otp_provider)
        if (
            check_candidate(
                version,
                expected_latest,
                directory,
                runner,
                registry_checker,
                acceptance_evidence,
            )
            != identity
        ):
            raise RuntimeError(
                "Release identity or acceptance evidence changed during authentication"
            )
        mutate_tag(version, runner, otp)
        verify_promoted(directory, version, identity[:2], runner, registry_checker)
        print(f"Promoted existing {PACKAGE}@{version} bytes to latest.")


def rollback(
    from_version: str,
    to_version: str,
    apply: bool,
    runner: Callable[[list[str]], str] = run_npm,
    directory: Path | None = None,
    registry_checker: Callable[[Path, str], None] = verify_registry_bytes,
    otp_provider: Callable[[], str] | None = None,
) -> None:
    from_version = stable(from_version)
    to_version = stable(to_version)
    if from_version == to_version:
        raise ValueError("Rollback versions must differ")
    if directory is None:
        raise RuntimeError("Rollback requires the recorded previous release artifact")

    def check() -> tuple[str, str]:
        verify_manifest(directory, to_version)
        registry_checker(directory, to_version)
        identity = registry_identity(directory, to_version, runner)
        if view(f"{PACKAGE}@latest", "version", runner) != from_version:
            raise RuntimeError("npm latest changed; refuse a stale rollback decision")
        return identity

    with tag_lock():
        identity = check()
        if not apply:
            print(
                f"Dry run: latest may roll back from {from_version} to {to_version}; no registry mutation performed."
            )
            return
        otp = authenticate(runner, otp_provider)
        if check() != identity:
            raise RuntimeError(
                "Rollback artifact identity changed during authentication"
            )
        mutate_tag(to_version, runner, otp)
        verify_promoted(directory, to_version, identity, runner, registry_checker)
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
    promotion.add_argument("--prompt-otp", action="store_true")
    rollback_parser = subparsers.add_parser("rollback")
    rollback_parser.add_argument("--from-version", required=True)
    rollback_parser.add_argument("--to-version", required=True)
    rollback_parser.add_argument("--artifacts", required=True, type=Path)
    rollback_parser.add_argument("--apply", action="store_true")
    rollback_parser.add_argument("--prompt-otp", action="store_true")
    args = parser.parse_args()
    if args.prompt_otp and (not args.apply or not sys.stdin.isatty()):
        raise RuntimeError(
            "--prompt-otp requires --apply in an interactive owner terminal"
        )
    otp_provider = (
        (lambda: getpass.getpass("npm one-time password (not echoed): "))
        if args.prompt_otp
        else None
    )
    if args.command == "promote":
        promote(
            args.version,
            args.expected_latest,
            args.artifacts,
            args.apply,
            acceptance_evidence=args.acceptance_evidence,
            otp_provider=otp_provider,
        )
    else:
        rollback(
            args.from_version,
            args.to_version,
            args.apply,
            directory=args.artifacts,
            otp_provider=otp_provider,
        )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 -- Never expose payloads from child or evidence exceptions.
        print(
            "Release tag operation failed; no private command output was emitted. Check the reviewed evidence and registry state before retrying.",
            file=sys.stderr,
        )
        sys.exit(1)
