"""Tests for which contract the hosted API reference must cover."""

import contextlib
import importlib.util
import io
import json
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-reference-coverage.py")
spec = importlib.util.spec_from_file_location("check_reference_coverage", SCRIPT)
coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage)


def contract(version: str, typescript: list[str], python: list[str]) -> dict:
    return {
        "schemaVersion": 1,
        "packages": {
            "typescript": {
                "version": version,
                "entrypoints": {".": {"publicExports": typescript}},
            },
            "python": {
                "version": "0.14.0",
                "modules": {"hue_sdk": {"publicExports": python}},
            },
        },
    }


class HostedReferenceCoverageTests(unittest.TestCase):
    def test_exports_added_at_the_published_version_use_the_release_tag(self):
        released = contract("0.26.0", ["Hue"], ["Hue"])
        local = contract("0.26.0", ["Hue", "WorldClientHint"], ["Hue", "WorldSurfaceConnection"])
        selected = coverage.select_hosted_contract(local, "0.26.0", None, released)
        self.assertIs(selected, released)

    def test_matching_release_uses_the_working_tree(self):
        released = contract("0.26.0", ["Hue"], ["Hue"])
        local = contract("0.26.0", ["Hue"], ["Hue"])
        selected = coverage.select_hosted_contract(local, "0.26.0", None, released)
        self.assertIs(selected, local)

    def test_unpublished_version_uses_the_docs_snapshot(self):
        local = contract("0.27.0", ["Hue", "WorldClientHint"], ["Hue"])
        published = contract("0.26.0", ["Hue"], ["Hue"])
        selected = coverage.select_hosted_contract(local, "0.26.0", published, None)
        self.assertIs(selected, published)

    def test_docs_snapshot_must_match_npm(self):
        local = contract("0.27.0", ["Hue"], ["Hue"])
        published = contract("0.25.0", ["Hue"], ["Hue"])
        with self.assertRaisesRegex(RuntimeError, "docs SDK snapshot"):
            coverage.select_hosted_contract(local, "0.26.0", published, None)

    def test_same_version_with_extra_exports_fetches_the_release_tag(self):
        local = json.loads((coverage.ROOT / "docs-contract.json").read_text())
        version = local["packages"]["typescript"]["version"]
        released = contract(version, ["Hue"], ["Hue"])
        fetched: list[str] = []

        def fake_fetch(url: str) -> str:
            fetched.append(url)
            if url == coverage.NPM_LATEST:
                return json.dumps({"version": version})
            if url == coverage.released_contract_url(version):
                return json.dumps(released)
            raise AssertionError(url)

        original = coverage.fetch
        coverage.fetch = fake_fetch
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                selected = coverage.published_contract()
        finally:
            coverage.fetch = original
        self.assertIn(f"typescript-v{version}", output.getvalue())
        self.assertEqual(coverage.export_names(selected), coverage.export_names(released))
        self.assertNotEqual(coverage.export_names(selected), coverage.export_names(local))
        self.assertNotIn(coverage.PUBLISHED_CONTRACT, fetched)
