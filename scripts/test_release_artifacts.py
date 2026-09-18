"""Failure-boundary tests for the public archive gate (no registry writes)."""

import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "release_artifacts", Path(__file__).with_name("release-artifacts.py")
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ArchiveGateTests(unittest.TestCase):
    def archive(self, folder, changes=None, metadata_changes=None):
        metadata = {
            "name": "@hue-run/sdk",
            "version": "1.2.3",
            "license": "MIT",
            "publishConfig": {"access": "public"},
            "exports": {
                ".": {"import": "./dist/index.js", "types": "./dist/index.d.ts"},
                "./package.json": "./package.json",
            },
        }
        metadata.update(metadata_changes or {})
        files = {
            "package/package.json": json.dumps(metadata).encode(),
            "package/LICENSE": b"Synthetic fixture license",
            "package/dist/index.js": b"export {};",
            "package/dist/index.d.ts": b"export {};",
        }
        files.update(changes or {})
        archive = Path(folder) / "package.tgz"
        with tarfile.open(archive, "w:gz") as output:
            for name, content in files.items():
                if content is None:
                    continue
                item = tarfile.TarInfo(name)
                item.size = len(content)
                output.addfile(item, io.BytesIO(content))
        return archive

    def test_complete_public_archive_passes(self):
        with tempfile.TemporaryDirectory() as folder:
            release.inspect(self.archive(folder), "typescript", "1.2.3")

    def test_rejects_private_metadata_hooks_and_wrong_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            for change in (
                {"private": True},
                {"version": "9.9.9"},
                {"name": "@another-org/sdk"},
                {"license": "UNLICENSED"},
                {"scripts": {"postinstall": "some-command"}},
                {"dependencies": {"ajv": "8.20.0"}},
            ):
                with self.subTest(change=change), self.assertRaises(AssertionError):
                    release.inspect(
                        self.archive(folder, metadata_changes=change),
                        "typescript",
                        "1.2.3",
                    )

    def test_rejects_secret_files_path_traversal_and_missing_exports(self):
        with tempfile.TemporaryDirectory() as folder:
            for change in (
                {"package/.env.local": b"SYNTHETIC=1"},
                {"package/../../outside": b"x"},
                {"package/dist/index.js": None},
                {"package/LICENSE": None},
                {"package/key.pem": b"-----BEGIN PRIVATE KEY-----"},
            ):
                with (
                    self.subTest(files=list(change)),
                    self.assertRaises(AssertionError),
                ):
                    release.inspect(
                        self.archive(folder, changes=change), "typescript", "1.2.3"
                    )

    def test_rejects_extra_files_in_release_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            self.archive(folder).rename(Path(folder) / "hue-run-sdk-1.2.3.tgz")
            (Path(folder) / "extra.whl").write_bytes(b"unexpected")
            with patch(
                "sys.argv",
                ["release-artifacts.py", "inspect", "typescript", "1.2.3", folder],
            ):
                with self.assertRaisesRegex(
                    AssertionError, "Unexpected artifact inventory"
                ):
                    release.main()

    def test_rejects_registry_bytes_different_from_tested_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = {
                "language": "typescript",
                "version": "1.2.3",
                "artifacts": [{"filename": "hue-run-sdk-1.2.3.tgz", "sha256": "0" * 64}],
            }
            (Path(folder) / "release-manifest.json").write_text(json.dumps(manifest))
            metadata = json.dumps(
                {"dist": {"tarball": "https://registry.npmjs.org/synthetic.tgz"}}
            ).encode()
            with patch(
                "sys.argv",
                ["release-artifacts.py", "registry", "typescript", "1.2.3", folder],
            ):
                with patch.object(
                    release, "read_url", side_effect=[metadata, b"different bytes"]
                ):
                    with self.assertRaisesRegex(
                        AssertionError, "Registry bytes differ"
                    ):
                        release.main()


if __name__ == "__main__":
    unittest.main()
