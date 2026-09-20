"""Offline identity and unchanged-archive tests; never dispatch or publish."""
import copy
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("prepared", Path(__file__).with_name("verify-prepared-release.py"))
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
COMMIT = "a" * 40


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
            archive = root / "hue-run-sdk-0.4.0.tgz"
            archive.write_bytes(b"synthetic archive")
            manifest = {"commit": COMMIT, "version": "0.4.0", "language": "typescript",
                        "artifacts": [{"filename": archive.name, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                                       "integrity": "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode("ascii")}]}
            (root / "release-manifest.json").write_text(json.dumps(manifest))
            module.validate_archive(root, COMMIT, "0.4.0")
            archive.write_bytes(b"different bytes")
            with self.assertRaises(ValueError):
                module.validate_archive(root, COMMIT, "0.4.0")
            with self.assertRaises(ValueError):
                module.validate_archive(root, "b" * 40, "0.4.0")
