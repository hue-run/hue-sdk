"""Failure-boundary tests for the public archive gate (no registry writes)."""

import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
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

    def parser_archive(self, folder, changes=None, metadata_changes=None):
        metadata = {
            "dependencies": {
                "@opentelemetry/core": "2.11.0",
                "@babel/parser": "7.29.9",
            },
            "exports": {
                ".": {"import": "./dist/index.js", "types": "./dist/index.d.ts"},
                "./setup": {"import": "./dist/setup.js"},
                "./package.json": "./package.json",
            },
        }
        metadata.update(metadata_changes or {})
        files = {
            "package/dist/setup.js": b'export { inspect } from "./setup/application.js";',
            "package/dist/setup/application.js": b'export { inspect } from "./source.js";',
            "package/dist/setup/source.js": (
                b'import { parse } from "@babel/parser";\nexport const inspect = parse;'
            ),
        }
        files.update(changes or {})
        return self.archive(folder, files, metadata)

    def test_allows_reviewed_setup_only_parser_without_expanding_core_dependencies(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            release.inspect(self.parser_archive(folder), "typescript", "1.2.3")
            # Comments/strings/regex are data; template substitutions are code.
            release.inspect(
                self.parser_archive(
                    folder,
                    {
                        "package/dist/index.js": (
                            b'// import "./missing.js";\n'
                            b"const note = 'import \"./missing.js\";';\n"
                            b"const pattern = /import[\"']/;\n"
                            b'const label = `import("./missing.js")`;\nexport {};'
                        ),
                    },
                ),
                "typescript",
                "1.2.3",
            )

    def test_rejects_wrong_parser_pin_unknown_dependency_or_missing_parser_module(self):
        with tempfile.TemporaryDirectory() as folder:
            for dependencies in (
                {"@babel/parser": "^7.29.9"},
                {"@babel/parser": "7.29.8"},
                {"@babel/parser": "7.29.9", "unknown-parser": "1.0.0"},
                {},
            ):
                with (
                    self.subTest(dependencies=dependencies),
                    self.assertRaises(AssertionError),
                ):
                    release.inspect(
                        self.parser_archive(
                            folder, metadata_changes={"dependencies": dependencies}
                        ),
                        "typescript",
                        "1.2.3",
                    )
            for contents in (None, b"export const inspect = () => undefined;"):
                with (
                    self.subTest(missing=contents is None),
                    self.assertRaises(AssertionError),
                ):
                    release.inspect(
                        self.parser_archive(
                            folder,
                            {
                                "package/dist/setup/source.js": contents,
                            },
                        ),
                        "typescript",
                        "1.2.3",
                    )

    def test_rejects_parser_from_any_other_module(self):
        with tempfile.TemporaryDirectory() as folder:
            for module in (
                "package/dist/index.js",
                "package/dist/setup/application.js",
            ):
                for source in (
                    b'import { parse } from "@babel/parser";',
                    b'import { parse } from "\\x40babel/parser";',
                    b'import { parse } from "@babel/parser/lib/index.js";',
                ):
                    with self.subTest(module=module), self.assertRaises(AssertionError):
                        release.inspect(
                            self.parser_archive(folder, {module: source}),
                            "typescript",
                            "1.2.3",
                        )

    def test_rejects_direct_indirect_and_computed_core_access_to_setup(self):
        with tempfile.TemporaryDirectory() as folder:
            for source in (
                b'import "./setup/source.js";',
                b'export { inspect } from "./setup/source.js";',
                b'export * from "./setup.js";',
                b'export * from "@hue-run/sdk/setup";',
                b'await import("./setup/source.js");',
                b'await import("./" + "setup/source.js");',
                b"await import(target);",
                b'const value = `${await import("./setup/source.js")}`;',
                b'import "./s\\u0065tup/source.js";',
                b'require("./setup/source.js");',
                b'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("./setup/source.js");',
                b'import { createRequire as make } from "node:module"; const load = make(import.meta.url); load("./setup/source.js");',
                b'const module = await import("node:module"); const load = module.createRequire(import.meta.url); load("./setup/source.js");',
                b'const loader = new Function("return import(\\"./setup/source.js\\")");',
            ):
                with self.subTest(case=source[:24]), self.assertRaises(AssertionError):
                    release.inspect(
                        self.parser_archive(
                            folder,
                            {
                                "package/dist/index.js": source,
                            },
                        ),
                        "typescript",
                        "1.2.3",
                    )
            with self.assertRaisesRegex(AssertionError, "Non-setup module"):
                release.inspect(
                    self.parser_archive(
                        folder,
                        {
                            "package/dist/index.js": b'export { inspect } from "./shared.js";',
                            "package/dist/shared.js": b'export { inspect } from "./setup/source.js";',
                        },
                    ),
                    "typescript",
                    "1.2.3",
                )

    def test_rejects_setup_exposure_from_non_setup_package_entrypoints(self):
        with tempfile.TemporaryDirectory() as folder:
            for metadata in (
                {"exports": {".": "./dist/setup.js"}},
                {
                    "exports": {
                        ".": "./dist/index.js",
                        "./parser": "./dist/setup/source.js",
                    }
                },
                {"main": "./dist/setup.js"},
                {"module": "./dist/setup/source.js"},
            ):
                with (
                    self.subTest(fields=list(metadata)),
                    self.assertRaisesRegex(AssertionError, "Non-setup"),
                ):
                    release.inspect(
                        self.parser_archive(folder, metadata_changes=metadata),
                        "typescript",
                        "1.2.3",
                    )

    def test_preserves_existing_bounded_core_dynamic_builtin_and_optional_peer_loaders(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            release.inspect(
                self.parser_archive(
                    folder,
                    {
                        "package/dist/index.js": b'export { transport } from "./transport.js";',
                        "package/dist/transport.js": b'export async function transport(protocol) { return import(protocol === "https:" ? "node:https" : "node:http"); }',
                        "package/dist/ai-sdk.js": b'import { createRequire } from "node:module"; export const metadata = createRequire(import.meta.url)("ai/package.json");',
                        "package/dist/evals/scorers.js": b'import { createRequire } from "node:module"; export const optional = createRequire(import.meta.url).resolve("ajv/dist/2020.js");',
                    },
                ),
                "typescript",
                "1.2.3",
            )

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
                {"package/.hue/installation.json": b"{}"},
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
            with (
                patch(
                    "sys.argv",
                    ["release-artifacts.py", "inspect", "typescript", "1.2.3", folder],
                ),
                self.assertRaisesRegex(AssertionError, "Unexpected artifact inventory"),
            ):
                release.main()

    def test_rejects_every_credential_namespace_and_truncated_claims(self):
        # Generated synthetic values never enter assertion output or retained artifacts.
        values = [
            b"_".join((b"hue", b"sk", environment, b"s" * 32))
            for environment in (b"live", b"test")
        ] + [
            b"_".join((b"hue", b"setup", environment, b"setup-" + b"a" * 24, b"s" * 43))
            for environment in (b"live", b"test")
        ]
        values.extend(
            [
                b"_".join((b"hue", b"install", b"s" * 43)),
                b"_".join((b"hue", b"claim", b"s" * 43)),
                b"https://example.invalid/setup/claim#" + b"s" * 43,
                b"https://example.invalid/setup/claim#" + b"s" * 7,
            ]
        )
        with tempfile.TemporaryDirectory() as folder:
            for index, value in enumerate(values):
                with (
                    self.subTest(case=index),
                    self.assertRaisesRegex(AssertionError, "Credential-like content"),
                ):
                    release.inspect(
                        self.archive(folder, {"package/dist/leaked.js": value}),
                        "typescript",
                        "1.2.3",
                    )

    def test_rejects_registry_bytes_different_from_tested_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = {
                "language": "typescript",
                "version": "1.2.3",
                "artifacts": [
                    {"filename": "hue-run-sdk-1.2.3.tgz", "sha256": "0" * 64}
                ],
            }
            (Path(folder) / "release-manifest.json").write_text(json.dumps(manifest))
            metadata = json.dumps(
                {"dist": {"tarball": "https://registry.npmjs.org/synthetic.tgz"}}
            ).encode()
            with (
                patch(
                    "sys.argv",
                    ["release-artifacts.py", "registry", "typescript", "1.2.3", folder],
                ),
                patch.object(
                    release, "read_url", side_effect=[metadata, b"different bytes"]
                ),
                self.assertRaisesRegex(AssertionError, "Registry bytes differ"),
            ):
                release.main()


if __name__ == "__main__":
    unittest.main()
