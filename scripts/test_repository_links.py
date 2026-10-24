"""Prove GitHub targets resolve from actual Git refs, not host availability."""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "repository_links", Path(__file__).with_name("check-repository-links.py")
)
LINKS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LINKS)


class RepositoryLinkTests(unittest.TestCase):
    def test_existing_missing_and_wrong_ref_or_kind_use_real_git_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.check_output(
                    ["git", *args], cwd=root, text=True
                ).strip()

            git("init", "-q", "-b", "main")
            git("config", "user.name", "Synthetic")
            git("config", "user.email", "synthetic@example.test")
            (root / "docs").mkdir()
            (root / "docs/contract.md").write_text("# Contract\n")
            git("add", ".")
            git("commit", "-qm", "Initial contract")
            commit = git("rev-parse", "HEAD")
            git("tag", "v1")
            git("branch", "docs/contract")
            prefix = "https://github.com/hue-run/hue-sdk"
            for ref in ("main", "v1", commit, "docs/contract"):
                with self.subTest(ref=ref):
                    self.assertEqual(
                        LINKS.target_type(
                            f"{prefix}/blob/{ref}/docs/contract.md#contract", root
                        ),
                        "blob",
                    )
                    self.assertEqual(
                        LINKS.target_type(f"{prefix}/tree/{ref}/docs", root), "tree"
                    )
                    self.assertEqual(
                        LINKS.target_type(f"{prefix}/tree/{ref}", root), "tree"
                    )
            for suffix in (
                "blob/main/missing.md",
                "tree/main/missing",
                "blob/missing-ref/docs/contract.md",
                "blob/main/docs",
                "tree/main/docs/contract.md",
                "blob/main/../contract.md",
            ):
                with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                    LINKS.target_type(f"{prefix}/{suffix}", root)
            (root / "docs/contract.md").unlink()
            git("add", ".")
            git("commit", "-qm", "Remove current contract")
            with self.assertRaises(ValueError):
                LINKS.target_type(f"{prefix}/blob/main/docs/contract.md", root)
            self.assertEqual(
                LINKS.target_type(f"{prefix}/blob/v1/docs/contract.md", root), "blob"
            )
            self.assertIsNone(
                LINKS.target_type("https://github.com/other/repo/blob/main/file", root)
            )


if __name__ == "__main__":
    unittest.main()
