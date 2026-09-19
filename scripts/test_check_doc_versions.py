"""Tests for language-specific documentation version checks."""

import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name("check-doc-versions.py")
spec = importlib.util.spec_from_file_location("check_doc_versions", SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class DocumentationVersionTests(unittest.TestCase):
    versions = {"typescript": "0.3.0", "python": "0.2.2"}

    def test_package_guides_use_their_own_current_version(self):
        self.assertEqual(
            checker.stale_mentions(
                "packages/sdk-typescript/README.md",
                "Install the current package at 0.2.2.",
                self.versions,
            )[0].split(": stale version", 1)[0],
            "packages/sdk-typescript/README.md:1",
        )
        self.assertEqual(
            checker.stale_mentions(
                "packages/sdk-python/README.md",
                "Install the current package at 0.3.0.",
                self.versions,
            )[0].split(": stale version", 1)[0],
            "packages/sdk-python/README.md:1",
        )

    def test_mixed_document_can_state_both_current_versions(self):
        line = "Current releases are TypeScript 0.3.0 and Python 0.2.2."
        self.assertEqual(checker.stale_mentions("COMPATIBILITY.md", line, self.versions), [])

    def test_new_minor_versions_are_scanned(self):
        problems = checker.stale_mentions(
            "packages/sdk-typescript/README.md",
            "Install the current package at 0.4.0.",
            self.versions,
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("stale version 0.4.0", problems[0])


if __name__ == "__main__":
    unittest.main()
