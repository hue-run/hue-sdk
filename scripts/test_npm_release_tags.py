"""Tests for guarded npm candidate promotion without registry writes."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "npm_release_tags", Path(__file__).with_name("npm-release-tags.py")
)
tags = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tags)


class NpmReleaseTagTests(unittest.TestCase):
    def artifacts(self, folder: str, version: str = "0.4.0") -> Path:
        directory = Path(folder)
        (directory / "release-manifest.json").write_text(
            json.dumps(
                {
                    "commit": "a" * 40,
                    "language": "typescript",
                    "version": version,
                    "artifacts": [
                        {
                            "filename": f"hue-run-sdk-{version}.tgz",
                            "sha256": "b" * 64,
                        }
                    ],
                }
            )
        )
        return directory

    def evidence(self, folder: str) -> Path:
        path = Path(folder) / "hosted-acceptance.json"
        path.write_text(
            json.dumps(
                {
                    "format": 1,
                    "package": {
                        "name": "@hue-run/sdk",
                        "version": "0.4.0",
                        "sha256": "b" * 64,
                        "integrity": "sha512-" + "A" * 86 + "==",
                    },
                    "sdkCommit": "a" * 40,
                    "releaseRunUrl": "https://github.com/hue-run/hue-sdk/actions/runs/123",
                    "fernCommit": "c" * 40,
                    "hostedAcceptanceRunUrl": "https://github.com/hue-run/fern/actions/runs/456",
                    "hostedEvidenceSha256": "d" * 64,
                    "servingDatabaseIdentity": "production-db-generation-7",
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
            if args[:2] == ["view", "@hue-run/sdk@0.4.0"]:
                return (
                    "sha512-" + "A" * 86 + "=="
                    if args[2] == "dist.integrity"
                    else "https://registry.example/attestation"
                )
            if args[:2] == ["view", "@hue-run/sdk@0.3.2"]:
                return (
                    "https://registry.example/previous-attestation"
                    if args[2] == "dist.attestations.url"
                    else "0.3.2"
                )
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

    def test_apply_requires_matching_hosted_production_evidence_and_authentication(self):
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
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                tags.promote(
                    "v0.4",
                    "0.3.2",
                    self.artifacts(folder),
                    False,
                    self.runner([]),
                    lambda _directory, _version: None,
                )
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                tags.promote(
                    "0.4.0",
                    "0.3.2",
                    self.artifacts(folder, "0.4.1"),
                    False,
                    self.runner([]),
                    lambda _directory, _version: None,
                )

    def test_workflow_keeps_prepare_only_runs_nonpublishing_and_uses_closed_tag(self):
        workflow = (Path(__file__).parents[1] / ".github/workflows/release.yml").read_text()
        self.assertIn("default: latest", workflow)
        self.assertIn("options: [latest, hue-onboarding-candidate]", workflow)
        self.assertIn("if version == '0.4.0':", workflow)
        self.assertIn("0.4.0 must publish under the onboarding candidate tag", workflow)
        self.assertIn("if: inputs.publish && inputs.language == 'typescript'", workflow)
        self.assertIn('--tag "$NPM_DIST_TAG"', workflow)
        self.assertIn('prerelease="--prerelease"', workflow)
        self.assertNotIn("npm dist-tag add", workflow)


if __name__ == "__main__":
    unittest.main()
