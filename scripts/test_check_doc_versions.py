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

    def test_typescript_cli_can_explicitly_name_current_python_runtime(self):
        text = (
            "`@opentelemetry/context-async-hooks@2.11.0`; Python uses `hue-run==0.2.2`.\n"
            "generic project, receipt, evaluation, log or browsing APIs. Python `0.2.2` can export"
        )
        self.assertEqual(
            checker.stale_mentions("packages/sdk-typescript/CLI.md", text, self.versions), []
        )

    def test_explicit_language_versions_are_not_interchangeable(self):
        for name in ("COMPATIBILITY.md", "packages/sdk-typescript/CLI.md"):
            for line, stale in (
                ("TypeScript 0.2.2 and Python 0.2.2.", "0.2.2"),
                ("Python 0.2.2 and TypeScript 0.2.2.", "0.2.2"),
                ("TypeScript 0.3.0 and Python 0.3.0.", "0.3.0"),
                ("Python 0.3.0 and TypeScript 0.3.0.", "0.3.0"),
            ):
                with self.subTest(name=name, line=line):
                    problems = checker.stale_mentions(name, line, self.versions)
                    self.assertEqual(len(problems), 1)
                    self.assertIn(f"stale version {stale}", problems[0])

    def test_explicit_package_labels_override_guide_without_allowing_stale_versions(self):
        for line, expected_count in (
            ("@hue-run/sdk 0.3.0 and Python 0.2.2", 0),
            ("@hue-run/sdk 0.2.2 and Python 0.2.2", 1),
            ("PyPI 0.2.2 and npm 0.3.0", 0),
            ("PyPI 0.2.2 and npm 0.2.2", 1),
            ("Python 0.1.0", 1),
        ):
            with self.subTest(line=line):
                self.assertEqual(
                    len(checker.stale_mentions("packages/sdk-typescript/CLI.md", line, self.versions)),
                    expected_count,
                )

    def test_new_minor_versions_are_scanned(self):
        problems = checker.stale_mentions(
            "packages/sdk-typescript/README.md",
            "Install the current package at 0.4.0.",
            self.versions,
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("stale version 0.4.0", problems[0])

    def test_multi_digit_minor_versions_are_scanned(self):
        versions = {"typescript": "0.10.1", "python": "0.6.2"}
        problems = checker.stale_mentions(
            "packages/sdk-typescript/CLI.md",
            "TypeScript uses `@hue-run/sdk@0.10.0` and Python `0.6.1`; Python `0.6.2` is current.",
            versions,
        )
        self.assertEqual(len(problems), 2)
        self.assertIn("stale version 0.10.0", problems[0])
        self.assertIn("stale version 0.6.1", problems[1])
        current = "TypeScript `@hue-run/sdk@0.10.1` and Python `0.6.2`."
        self.assertEqual(checker.stale_mentions("README.md", current, versions), [])

    def test_tool_versions_are_not_sdk_versions(self):
        line = "Use Node 24, Bun 1.4.2 and uv 0.12.5; the release checks with twine==0.11.0."
        self.assertEqual(checker.stale_mentions("README.md", line, self.versions), [])
        stale = "Use uv 0.12.5 with TypeScript 0.12.5."
        self.assertEqual(len(checker.stale_mentions("README.md", stale, self.versions)), 1)


if __name__ == "__main__":
    unittest.main()
