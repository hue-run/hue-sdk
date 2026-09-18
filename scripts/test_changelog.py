"""Tests for the changelog release gate."""

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("changelog", Path(__file__).with_name("changelog.py"))
changelog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(changelog)

SAMPLE = """# Changelog

## @hue-run/sdk (TypeScript)

### Unreleased

#### Added

- Something pending.

### [0.2.0](https://example.test/typescript-v0.2.0) - 2026-10-01

#### Added

- TypeScript entry.

## hue-run (Python)

### [0.2.0](https://example.test/python-v0.2.0) - 2026-10-01

#### Fixed

- Python entry.

### [0.1.9] - 2026-09-01

- Older.
"""


class ChangelogGateTests(unittest.TestCase):
    def test_returns_the_entry_for_the_requested_package_only(self):
        self.assertEqual(
            changelog.section(SAMPLE, "typescript", "0.2.0"), "#### Added\n\n- TypeScript entry."
        )
        self.assertEqual(changelog.section(SAMPLE, "python", "0.2.0"), "#### Fixed\n\n- Python entry.")
        self.assertEqual(changelog.section(SAMPLE, "python", "0.1.9"), "- Older.")

    def test_rejects_missing_versions_and_unreleased_only_entries(self):
        for language, version in (("typescript", "0.1.9"), ("python", "0.3.0"), ("typescript", "Unreleased")):
            with self.subTest(language=language, version=version), self.assertRaises(AssertionError):
                changelog.section(SAMPLE, language, version)

    def test_notes_include_entry_run_link_and_checksums(self):
        text = changelog.notes(
            SAMPLE, "python", "0.2.0", "abc123", "https://example.test/run/1", "0" * 64 + "  hue_run-0.2.0.whl\n"
        )
        self.assertIn("- Python entry.", text)
        self.assertIn("https://example.test/run/1", text)
        self.assertIn("| `hue_run-0.2.0.whl` | `" + "0" * 64 + "` |", text)
        self.assertIn("pypi.org/project/hue-run/0.2.0", text)

    def test_real_changelog_has_entries_for_the_released_versions(self):
        real = (Path(__file__).resolve().parents[1] / "CHANGELOG.md").read_text()
        self.assertTrue(changelog.section(real, "typescript", "0.1.5"))
        self.assertTrue(changelog.section(real, "python", "0.1.3"))


if __name__ == "__main__":
    unittest.main()
