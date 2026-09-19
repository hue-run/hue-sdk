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

    def test_page_title_heading_matches_frontmatter_only_source(self):
        hosted = """# Compatibility

This matrix describes the current releases.
"""
        source = """---
title: "Compatibility"
description: "Tested runtimes."
---

This matrix describes the current releases.
"""
        titles = {drift.frontmatter_title(hosted), drift.frontmatter_title(source)} - {None}
        self.assertEqual(
            drift.drop_page_title(drift.normalize(hosted), titles),
            drift.drop_page_title(drift.normalize(source), titles),
        )

    def test_unpublished_candidate_reads_hosted_mirrors_from_docs_repo(self):
        self.assertEqual(
            drift.source_labels("0.3.0", "0.2.2"),
            {
                "compatibility": "hue-run/docs/sdks/compatibility.mdx",
                "skill": "hue-run/docs/skill.md",
            },
        )

    def test_published_tree_reads_hosted_mirrors_from_this_repository(self):
        self.assertEqual(
            drift.source_labels("0.2.2", "0.2.2"),
            {
                "compatibility": "COMPATIBILITY.md",
                "skill": "skills/hue/SKILL.md",
            },
        )


if __name__ == "__main__":
    unittest.main()
