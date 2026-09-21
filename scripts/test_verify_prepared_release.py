"""Offline identity and unchanged-archive tests; never dispatch or publish."""
import copy
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("prepared", Path(__file__).with_name("verify-prepared-release.py"))
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
COMMIT = "a" * 40
ARCHIVE = "hue-run-sdk-0.4.0.tgz"


def prepare_fixture(root):
    archive = root / ARCHIVE
    archive.write_bytes(b"synthetic archive")
    sha256 = hashlib.sha256(archive.read_bytes()).hexdigest()
    manifest = {
        "commit": COMMIT, "version": "0.4.0", "language": "typescript",
        "artifacts": [{
            "filename": archive.name, "sha256": sha256,
            "integrity": "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode("ascii"),
        }],
    }
    (root / "release-manifest.json").write_text(json.dumps(manifest))
    (root / "SHA256SUMS").write_text(f"{sha256}  {ARCHIVE}\n")
    return manifest


class PreparedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.run = dict(head_sha=COMMIT, head_branch="main", event="workflow_dispatch",
                        status="completed", conclusion="success", path=".github/workflows/release.yml",
                        repository={"full_name": "hue-run/hue-sdk"})
        self.jobs = {"total_count": 3, "jobs": [
            {"name": "prepare", "conclusion": "success"},
            {"name": "publish-npm", "conclusion": "skipped"},
            {"name": "publish-pypi", "conclusion": "skipped"},
        ]}

    def test_accepts_successful_same_commit_prepare_only(self):
        module.validate_run(self.run, self.jobs, COMMIT)

    def test_wrong_commit_branch_workflow_repository_or_conclusion_refused(self):
        for key, value in (("head_sha", "b" * 40), ("head_branch", "feature"),
                           ("event", "pull_request"), ("conclusion", "failure"),
                           ("path", ".github/workflows/ci.yml"),
                           ("repository", {"full_name": "other/sdk"})):
            with self.subTest(key=key), self.assertRaises(ValueError):
                module.validate_run({**self.run, key: value}, self.jobs, COMMIT)

    def test_published_or_incomplete_job_inventory_refused(self):
        for conclusion in ("success", "failure", None):
            jobs = copy.deepcopy(self.jobs)
            jobs["jobs"][1]["conclusion"] = conclusion
            with self.assertRaises(ValueError):
                module.validate_run(self.run, jobs, COMMIT)
        with self.assertRaises(ValueError):
            module.validate_run(self.run, {**self.jobs, "total_count": 4}, COMMIT)

    def test_exact_archive_digest_and_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prepare_fixture(root)
            module.validate_archive(root, COMMIT, "0.4.0")
            (root / ARCHIVE).write_bytes(b"different bytes")
            with self.assertRaises(ValueError):
                module.validate_archive(root, COMMIT, "0.4.0")
            with self.assertRaises(ValueError):
                module.validate_archive(root, "b" * 40, "0.4.0")

    def test_extra_files_and_directories_refused(self):
        for filename in ("extra.tgz", "extra.whl", "extra.tar.gz", "notes.txt", ".hidden", "directory"):
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                prepare_fixture(root)
                if filename == "directory":
                    (root / filename).mkdir()
                else:
                    (root / filename).write_bytes(b"uninspected extra")
                with self.assertRaisesRegex(ValueError, "directory inventory"):
                    module.validate_archive(root, COMMIT, "0.4.0")

    def test_each_required_file_must_exist_and_be_regular_not_linked(self):
        for filename in (ARCHIVE, "release-manifest.json", "SHA256SUMS"):
            for kind in ("missing", "symlink", "directory", "fifo"):
                with self.subTest(filename=filename, kind=kind), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary) / "artifacts"
                    root.mkdir()
                    prepare_fixture(root)
                    path = root / filename
                    data = path.read_bytes()
                    path.unlink()
                    if kind == "symlink":
                        target = Path(temporary) / "outside"
                        target.write_bytes(data)
                        path.symlink_to(target)
                    elif kind == "directory":
                        path.mkdir()
                    elif kind == "fifo":
                        os.mkfifo(path)
                    with self.assertRaises(ValueError):
                        module.validate_archive(root, COMMIT, "0.4.0")

    def test_artifact_directory_cannot_be_a_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "artifacts"
            root.mkdir()
            prepare_fixture(root)
            link = Path(temporary) / "linked"
            link.symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                module.validate_archive(link, COMMIT, "0.4.0")

    def test_checksums_require_one_exact_matching_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = prepare_fixture(root)
            digest = manifest["artifacts"][0]["sha256"]
            correct = f"{digest}  {ARCHIVE}\n"
            for checksum in (
                "", f"{'0' * 64}  {ARCHIVE}\n", correct * 2,
                f"{digest}  ../{ARCHIVE}\n", f"{digest}  extra.tgz\n",
                f"{digest} *{ARCHIVE}\n", correct.rstrip(), correct + "extra\n",
                "x" * 32_769,
            ):
                with self.subTest(length=len(checksum)):
                    (root / "SHA256SUMS").write_text(checksum)
                    with self.assertRaises(ValueError):
                        module.validate_archive(root, COMMIT, "0.4.0")

    def test_manifest_requires_closed_identity_and_archive_shape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = prepare_fixture(root)
            candidates = [[], {**original, "unknown": "extra"}, {**original, "artifacts": [None]}]
            extra = copy.deepcopy(original)
            extra["artifacts"][0]["unknown"] = "extra"
            candidates.append(extra)
            wrong_integrity = copy.deepcopy(original)
            wrong_integrity["artifacts"][0]["integrity"] = "sha512-incorrect"
            candidates.append(wrong_integrity)
            for candidate in candidates:
                (root / "release-manifest.json").write_text(json.dumps(candidate))
                with self.assertRaises(ValueError):
                    module.validate_archive(root, COMMIT, "0.4.0")

    def test_concurrent_archive_replacement_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prepare_fixture(root)
            actual_stat = module.os.stat
            replaced = False

            def changing_stat(path, *args, **kwargs):
                nonlocal replaced
                if path == ARCHIVE and not replaced:
                    replaced = True
                    (root / ARCHIVE).unlink()
                    (root / ARCHIVE).write_bytes(b"synthetic archive")
                return actual_stat(path, *args, **kwargs)

            with patch.object(module.os, "stat", side_effect=changing_stat):
                with self.assertRaisesRegex(ValueError, "changed during verification"):
                    module.validate_archive(root, COMMIT, "0.4.0")

    def test_package_children_do_not_receive_evidence_tokens(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/release.yml").read_text()
        steps = re.split(r"(?m)^      - ", workflow)
        package_steps = [step for step in steps if "verify-package.mjs --archive" in step]
        self.assertEqual(len(package_steps), 1)
        package_step = package_steps[0]
        self.assertNotIn("env:", package_step)
        self.assertNotIn("github.token", package_step)
        self.assertNotIn("verify-prepared-release.py", package_step)
        identity_steps = [step for step in steps if "verify-prepared-release.py" in step]
        self.assertEqual(len(identity_steps), 2)
        for step in identity_steps:
            self.assertIn("GH_TOKEN: ${{ github.token }}", step)
            self.assertNotIn("verify-package.mjs", step)
        command = re.search(r"(?m)^        run: (.+)$", package_step).group(1)
        with tempfile.TemporaryDirectory() as temporary:
            node = Path(temporary) / "node"
            node.write_text('#!/bin/sh\ntest -z "${GH_TOKEN+x}" && test -z "${GITHUB_TOKEN+x}"\n')
            node.chmod(0o700)
            result = subprocess.run(
                ["/bin/sh", "-c", command], check=False, capture_output=True, timeout=10,
                env={"PATH": temporary + os.pathsep + os.defpath, "GH_TOKEN": "synthetic-marker",
                     "GITHUB_TOKEN": "synthetic-marker", "RELEASE_VERSION": "0.4.0"},
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b"")
