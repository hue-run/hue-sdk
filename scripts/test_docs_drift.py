"""Tests for hosted-document normalization and skill identity checks."""

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-docs-drift.py")
spec = importlib.util.spec_from_file_location("check_docs_drift", SCRIPT)
drift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift)


class HostedDocumentationDriftTests(unittest.TestCase):
    def test_skill_metadata_accepts_mintlify_fields_and_quotes(self):
        source = """---
name: hue
description: Canonical description.
metadata:
  author: hue-run
  version: "0.2.3"
---
"""
        hosted = """---
name: "hue"
description: "Canonical description."
metadata:
  author: "hue-run"
  version: "0.2.3"
title: "skill.md"
---
"""
        self.assertEqual(drift.skill_metadata(source), drift.skill_metadata(hosted))

    def test_skill_metadata_exposes_cache_identity_drift(self):
        current = """---
name: hue
description: Canonical description.
metadata:
  author: hue-run
  version: "0.2.3"
---
"""
        stale = current.replace('version: "0.2.3"', 'version: "0.2.2"')
        self.assertNotEqual(drift.skill_metadata(current), drift.skill_metadata(stale))

    def test_typescript_version_reads_the_contract_package(self):
        self.assertEqual(
            drift.typescript_version(
                '{"packages":{"typescript":{"version":"0.2.2"},"python":{"version":"0.2.2"}}}'
            ),
            "0.2.2",
        )


if __name__ == "__main__":
    unittest.main()
