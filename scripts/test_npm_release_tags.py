"""Tests for guarded npm candidate promotion without registry writes."""

import base64
import hashlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout

spec = importlib.util.spec_from_file_location(
    "npm_release_tags", Path(__file__).with_name("npm-release-tags.py")
)
tags = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tags)
ARCHIVE = b"synthetic immutable archive"
ARCHIVE_HASH = hashlib.sha256(ARCHIVE).hexdigest()
ARCHIVE_INTEGRITY = (
    "sha512-" + base64.b64encode(hashlib.sha512(ARCHIVE).digest()).decode()
)


class NpmReleaseTagTests(unittest.TestCase):
    def setUp(self):
        # Simulated registry transitions are test data, not real publication evidence.
        self.enterContext(redirect_stdout(io.StringIO()))
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        lock = patch.object(tags, "lock_path", return_value=Path(folder.name) / "lock")
        lock.start()
        self.addCleanup(lock.stop)

    def artifacts(self, folder: str, version: str = "0.4.0") -> Path:
        directory = Path(folder)
        (directory / f"hue-run-sdk-{version}.tgz").write_bytes(ARCHIVE)
        (directory / "release-manifest.json").write_text(
            json.dumps(
                {
                    "commit": "a" * 40,
                    "language": "typescript",
                    "version": version,
                    "artifacts": [
                        {
                            "filename": f"hue-run-sdk-{version}.tgz",
                            "sha256": ARCHIVE_HASH,
                            "integrity": ARCHIVE_INTEGRITY,
                        }
                    ],
                }
            )
        )
        return directory

    def evidence(self, folder: str) -> Path:
        path = Path(folder) / "hosted-acceptance.json"
        identity_tuple = {
            "provider": "supabase",
            "environment": "production",
            "projectRef": "a" * 20,
            "database": "postgres",
            "migrationDigest": "e" * 64,
        }
        database_hash = hashlib.sha256(
            json.dumps(identity_tuple, separators=(",", ":")).encode()
        ).hexdigest()
        path.write_text(
            json.dumps(
                {
                    "format": 1,
                    "package": {
                        "name": "@hue-run/sdk",
                        "version": "0.4.0",
                        "sha256": ARCHIVE_HASH,
                        "integrity": ARCHIVE_INTEGRITY,
                    },
                    "sdkCommit": "a" * 40,
                    "releaseRunUrl": "https://github.com/hue-run/hue-sdk/actions/runs/123",
                    "fernCommit": "c" * 40,
                    "hostedAcceptanceRunUrl": "https://github.com/hue-run/fern/actions/runs/456",
                    "hostedEvidenceSha256": "d" * 64,
                    "servingArtifactSha256": "f" * 64,
                    "servingDatabaseIdentity": "sha256:" + database_hash,
                    "servingDatabaseIdentityTuple": identity_tuple,
                    "previousLatest": "0.3.2",
                    "productionAccepted": True,
                }
            )
        )
        return path

    def runner(self, calls, latest="0.3.2"):
        state = {"latest": latest}

        def run(args):
            calls.append(args)
            if args[:2] == ["view", "@hue-run/sdk@hue-onboarding-candidate"]:
                return "0.4.0"
            if args[0] == "view" and args[1] in [
                "@hue-run/sdk@0.4.0",
                "@hue-run/sdk@0.3.2",
            ]:
                version = args[1].rsplit("@", 1)[1]
                return {
                    "dist.integrity": ARCHIVE_INTEGRITY,
                    "dist.attestations.url": f"https://registry.npmjs.org/-/npm/v1/attestations/@hue-run%2fsdk@{version}",
                    "version": version,
                }[args[2]]
            if args[:2] == ["view", "@hue-run/sdk@latest"]:
                return state["latest"]
            if args[:2] == ["dist-tag", "add"]:
                state["latest"] = args[2].rsplit("@", 1)[1]
                return ""
            if args == ["whoami"]:
                return "maintainer"
            raise AssertionError(args)

        return run

    def test_promotion_dry_run_never_mutates_tags(self):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            tags.promote(
                "0.4.0",
                "0.3.2",
                self.artifacts(folder),
                False,
                self.runner(calls),
                lambda _directory, _version: None,
            )
            self.assertFalse(any(call[:2] == ["dist-tag", "add"] for call in calls))

    def test_stale_latest_fails_before_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            with self.assertRaisesRegex(RuntimeError, "latest changed"):
                tags.promote(
                    "0.4.0",
                    "0.3.1",
                    self.artifacts(folder),
                    True,
                    self.runner(calls),
                    lambda _directory, _version: None,
                )
            self.assertFalse(any(call[:2] == ["dist-tag", "add"] for call in calls))

    def test_rollback_dry_run_requires_current_and_existing_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            tags.rollback(
                "0.4.0",
                "0.3.2",
                False,
                self.runner(calls, latest="0.4.0"),
                self.artifacts(folder, "0.3.2"),
                lambda _directory, _version: None,
            )
            self.assertFalse(any(call[:2] == ["dist-tag", "add"] for call in calls))
            with self.assertRaises(ValueError):
                tags.rollback(
                    "0.4.0",
                    "0.4.0",
                    False,
                    self.runner([]),
                    self.artifacts(folder, "0.3.2"),
                    lambda _directory, _version: None,
                )

    def test_rejects_mismatched_manifest(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            self.assertRaisesRegex(RuntimeError, "does not match"),
        ):
            tags.promote(
                "0.4.0",
                "0.3.2",
                self.artifacts(folder, "0.4.1"),
                False,
                self.runner([]),
                lambda _directory, _version: None,
            )

    def test_apply_requires_matching_hosted_production_evidence_and_authentication(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            artifacts = self.artifacts(folder)
            with self.assertRaisesRegex(RuntimeError, "requires exact hosted"):
                tags.promote(
                    "0.4.0",
                    "0.3.2",
                    artifacts,
                    True,
                    self.runner(calls),
                    lambda _directory, _version: None,
                )
            tags.promote(
                "0.4.0",
                "0.3.2",
                artifacts,
                True,
                self.runner(calls),
                lambda _directory, _version: None,
                self.evidence(folder),
            )
            self.assertIn(["whoami"], calls)
            self.assertTrue(any(call[:2] == ["dist-tag", "add"] for call in calls))

    def test_rejects_unstable_or_mismatched_manifest(self):
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(ValueError):
            tags.promote(
                "v0.4",
                "0.3.2",
                self.artifacts(folder),
                False,
                self.runner([]),
                lambda _directory, _version: None,
            )

    def test_global_local_lock_refuses_concurrent_promotion_without_registry_calls(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            with tags.tag_lock(), self.assertRaisesRegex(RuntimeError, "in progress"):
                tags.promote(
                    "0.4.0",
                    "0.3.2",
                    self.artifacts(folder),
                    True,
                    self.runner(calls),
                    lambda *_: None,
                    self.evidence(folder),
                )
            self.assertEqual(calls, [])

    def test_authentication_time_latest_change_refuses_both_mutations(self):
        with tempfile.TemporaryDirectory() as folder:
            for operation in ("promote", "rollback"):
                with self.subTest(operation=operation):
                    calls = []
                    original = self.runner(
                        calls, "0.4.0" if operation == "rollback" else "0.3.2"
                    )
                    authenticated = False

                    def run(args, original=original):
                        nonlocal authenticated
                        if args == ["whoami"]:
                            authenticated = True
                        if authenticated and args[:2] == [
                            "view",
                            "@hue-run/sdk@latest",
                        ]:
                            return "0.3.3"
                        return original(args)

                    with self.assertRaisesRegex(RuntimeError, "latest changed"):
                        if operation == "promote":
                            tags.promote(
                                "0.4.0",
                                "0.3.2",
                                self.artifacts(folder),
                                True,
                                run,
                                lambda *_: None,
                                self.evidence(folder),
                            )
                        else:
                            tags.rollback(
                                "0.4.0",
                                "0.3.2",
                                True,
                                run,
                                self.artifacts(folder, "0.3.2"),
                                lambda *_: None,
                            )
                    self.assertFalse(
                        any(call[:2] == ["dist-tag", "add"] for call in calls)
                    )

    def test_authentication_time_evidence_edit_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            original = self.runner(calls)
            evidence = self.evidence(folder)

            def run(args):
                if args == ["whoami"]:
                    value = json.loads(evidence.read_text())
                    value["servingArtifactSha256"] = "a" * 64
                    evidence.write_text(json.dumps(value))
                return original(args)

            with self.assertRaisesRegex(RuntimeError, "evidence changed"):
                tags.promote(
                    "0.4.0",
                    "0.3.2",
                    self.artifacts(folder),
                    True,
                    run,
                    lambda *_: None,
                    evidence,
                )
            self.assertFalse(any(call[:2] == ["dist-tag", "add"] for call in calls))

    def test_checks_exact_registry_bytes_before_and_after_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            calls, checks = [], []
            tags.promote(
                "0.4.0",
                "0.3.2",
                self.artifacts(folder),
                True,
                self.runner(calls),
                lambda *_: checks.append(True),
                self.evidence(folder),
            )
            self.assertEqual(len(checks), 3)
            mutation = next(
                index
                for index, call in enumerate(calls)
                if call[:2] == ["dist-tag", "add"]
            )
            self.assertTrue(
                any(call[-1] == "dist.integrity" for call in calls[mutation + 1 :])
            )
            self.assertEqual(calls[-1], ["view", "@hue-run/sdk@latest", "version"])
            self.assertFalse(
                any(call[0] in {"publish", "pack", "install"} for call in calls)
            )

    def test_refuses_local_archive_mismatch_and_post_mutation_integrity_change(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = self.artifacts(folder)
            (directory / "hue-run-sdk-0.4.0.tgz").write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "Local archive bytes differ"):
                tags.promote(
                    "0.4.0", "0.3.2", directory, False, self.runner([]), lambda *_: None
                )
            calls = []
            original = self.runner(calls)
            mutated = False

            def run(args):
                nonlocal mutated
                if args[:2] == ["dist-tag", "add"]:
                    mutated = True
                if mutated and args[-1] == "dist.integrity":
                    return "sha512-changed"
                return original(args)

            with self.assertRaisesRegex(RuntimeError, "Registry integrity differs"):
                tags.promote(
                    "0.4.0",
                    "0.3.2",
                    self.artifacts(folder),
                    True,
                    run,
                    lambda *_: None,
                    self.evidence(folder),
                )
            self.assertEqual(sum(call[:2] == ["dist-tag", "add"] for call in calls), 1)

    def test_evidence_refuses_other_repositories_private_values_and_invalid_database_binding(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            directory = self.artifacts(folder)
            for field, value in [
                ("releaseRunUrl", "https://github.com/other/hue-sdk/actions/runs/123"),
                (
                    "hostedAcceptanceRunUrl",
                    "https://github.com/hue-run/hue-sdk/actions/runs/456",
                ),
                ("servingDatabaseIdentity", "sha256:" + "0" * 64),
                (
                    "servingDatabaseIdentity",
                    "_".join(("hue", "setup", "test", "setup-" + "a" * 24, "s" * 43)),
                ),
                (
                    "servingArtifactSha256",
                    "https://example.invalid/verification?private=1",
                ),
            ]:
                with self.subTest(field=field):
                    evidence = self.evidence(folder)
                    data = json.loads(evidence.read_text())
                    data[field] = value
                    evidence.write_text(json.dumps(data))
                    with self.assertRaises(RuntimeError):
                        tags.promote(
                            "0.4.0",
                            "0.3.2",
                            directory,
                            False,
                            self.runner([]),
                            lambda *_: None,
                            evidence,
                        )

    def test_bounded_subprocess_suppresses_failed_oversized_and_timeout_payloads(self):
        secret = "_".join(("hue", "setup", "test", "setup-" + "a" * 24, "s" * 43))
        for code in [
            f"import sys; print({secret!r}); sys.exit(1)",
            "print('x' * 100000)",
        ]:
            with self.assertRaisesRegex(
                RuntimeError, "private output was suppressed"
            ) as caught:
                tags.bounded_command([sys.executable, "-c", code])
            self.assertNotIn(secret, str(caught.exception))
        with (
            patch.object(tags, "COMMAND_TIMEOUT_SECONDS", 0.05),
            self.assertRaisesRegex(RuntimeError, "private output was suppressed"),
        ):
            tags.bounded_command([sys.executable, "-c", "import time; time.sleep(10)"])

    def test_otp_is_not_a_command_argument_or_retained_process_environment(self):
        with patch.object(tags, "bounded_command", return_value="") as command:
            tags.run_npm(
                ["dist-tag", "add", "@hue-run/sdk@0.4.0", "latest"], otp="123456"
            )
        args, environment = command.call_args.args
        self.assertNotIn("123456", args)
        self.assertEqual(environment["npm_config_otp"], "123456")
        self.assertNotEqual(os.environ.get("npm_config_otp"), "123456")

    def test_workflow_keeps_prepare_only_runs_nonpublishing_and_uses_closed_tag(self):
        workflow = (
            Path(__file__).parents[1] / ".github/workflows/release.yml"
        ).read_text()
        self.assertIn("default: latest", workflow)
        self.assertIn("options: [latest, hue-onboarding-candidate]", workflow)
        self.assertIn("run: python3 scripts/release-policy.py", workflow)
        policy_spec = importlib.util.spec_from_file_location(
            "release_policy", Path(__file__).with_name("release-policy.py")
        )
        policy = importlib.util.module_from_spec(policy_spec)
        policy_spec.loader.exec_module(policy)
        with self.assertRaises(ValueError):
            policy.validate("typescript", "0.4.0", "latest", True, "123")
        with self.assertRaises(ValueError):
            policy.validate("typescript", "0.4.0", "hue-onboarding-candidate", True, "")
        policy.validate("typescript", "0.4.0", "latest", False, "")
        policy.validate("typescript", "0.3.3", "latest", True, "")
        self.assertIn("if: inputs.publish && inputs.language == 'typescript'", workflow)
        self.assertIn('--tag "$NPM_DIST_TAG"', workflow)
        self.assertIn('prerelease="--prerelease"', workflow)
        self.assertNotIn("npm dist-tag add", workflow)


if __name__ == "__main__":
    unittest.main()
