"""Inspect release inventory and bind published bytes to the tested archives."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import posixpath
import re
import subprocess
import tarfile
import zipfile
from email.parser import BytesParser
from pathlib import Path, PurePosixPath
from urllib.request import Request, urlopen

SETUP_PARSER = "@babel/parser"
SETUP_PARSER_VERSION = "7.29.9"
SETUP_PARSER_MODULE = "package/dist/setup/source.js"


def javascript_tokens(source: str) -> list[tuple[str, str]]:
    """Small fail-closed lexer for tsc output; never execute an archive module.

    This is an import-boundary checker, not a general JavaScript parser. Strings,
    comments and regexp bodies cannot hide an import; template substitutions are
    inspected as code. Unsupported lexical forms require explicit review.
    """
    tokens: list[tuple[str, str]] = []
    index = source.find("\n") + 1 if source.startswith("#!") else 0
    assert not source.startswith("#!") or index > 0, "Unterminated JavaScript shebang"

    def scan(stop_at_brace=False):
        nonlocal index
        braces = 0
        while index < len(source):
            char = source[index]
            if char.isspace():
                index += 1
            elif source.startswith("//", index):
                end = source.find("\n", index)
                index = len(source) if end == -1 else end + 1
            elif source.startswith("/*", index):
                end = source.find("*/", index + 2)
                assert end != -1, "Unterminated JavaScript comment"
                index = end + 2
            elif char in "\"'":
                quote, start = char, index + 1
                index += 1
                while index < len(source) and source[index] != quote:
                    index += 2 if source[index] == "\\" else 1
                assert index < len(source), "Unterminated JavaScript string"
                tokens.append(("string", source[start:index]))
                index += 1
            elif char == "`":
                tokens.append(("template", "`"))
                index += 1
                while index < len(source) and source[index] != "`":
                    if source[index] == "\\":
                        index += 2
                    elif source.startswith("${", index):
                        index += 2
                        scan(True)
                    else:
                        index += 1
                assert index < len(source), "Unterminated JavaScript template"
                index += 1
                tokens.append(("template", "`"))
            elif char == "/":
                previous = tokens[-1] if tokens else None
                # The current emitted division form is an identifier divided by a
                # numeric literal. Other ambiguous slash syntax is not accepted.
                if (
                    previous
                    and previous[0] in {"word", "number"}
                    and re.match(r"\s*[0-9]", source[index + 1 :])
                ):
                    tokens.append(("punct", "/"))
                    index += 1
                    continue
                assert previous is None or previous[1] in {
                    "(",
                    "[",
                    "{",
                    "=",
                    ":",
                    ",",
                    "!",
                    "?",
                    ";",
                    "return",
                    "throw",
                    "&",
                    "|",
                    ">",
                }, "Ambiguous JavaScript slash syntax"
                index += 1
                in_class = False
                while index < len(source):
                    char = source[index]
                    if char == "\\":
                        index += 2
                        continue
                    if char == "[":
                        in_class = True
                    elif char == "]":
                        in_class = False
                    elif char == "/" and not in_class:
                        break
                    assert char not in "\r\n", "Invalid JavaScript regexp"
                    index += 1
                assert index < len(source), "Unterminated JavaScript regexp"
                index += 1
                while index < len(source) and source[index].isalpha():
                    index += 1
                tokens.append(("regexp", "/"))
            elif char.isalpha() or char in "_$":
                start = index
                index += 1
                while index < len(source) and (
                    source[index].isalnum() or source[index] in "_$"
                ):
                    index += 1
                tokens.append(("word", source[start:index]))
            elif char.isdigit():
                start = index
                index += 1
                while index < len(source) and (
                    source[index].isalnum() or source[index] in "._"
                ):
                    index += 1
                tokens.append(("number", source[start:index]))
            else:
                assert char != "\\", "Escaped JavaScript identifiers are not supported"
                if char == "}":
                    if stop_at_brace and braces == 0:
                        index += 1
                        return
                    braces -= 1
                elif char == "{":
                    braces += 1
                tokens.append(("punct", char))
                index += 1
        assert not stop_at_brace, "Unterminated JavaScript template substitution"

    scan()
    return tokens


def module_imports(source: str, filename: str) -> list[str]:
    tokens = javascript_tokens(source)
    imports = []

    def literal(index):
        assert index < len(tokens) and tokens[index][0] == "string", (
            "Module imports must use literal specifiers"
        )
        value = tokens[index][1]
        assert (
            value and "\\" not in value and not any(char.isspace() for char in value)
        ), "Escaped or ambiguous module specifier"
        if value == "node:module":
            assert filename in {
                "package/dist/ai-sdk.js",
                "package/dist/evals/scorers.js",
            } and tokens[max(0, index - 5) : index] == [
                ("word", "import"),
                ("punct", "{"),
                ("word", "createRequire"),
                ("punct", "}"),
                ("word", "from"),
            ], "Unsupported or aliased module loader"
        return value

    for index, (kind, value) in enumerate(tokens):
        if kind != "word":
            continue
        after = tokens[index + 1 : index + 32]
        if value in {"eval", "Function"} and after[:1] == [("punct", "(")]:
            raise AssertionError(
                "Dynamic evaluation is outside the archive import boundary"
            )
        if value == "createRequire" and after[:1] == [("punct", "(")]:
            expected = {
                "package/dist/ai-sdk.js": (
                    'createRequire(import.meta.url)("ai/package.json")'
                ),
                "package/dist/evals/scorers.js": (
                    'createRequire(import.meta.url).resolve("ajv/dist/2020.js")'
                ),
            }.get(filename)
            assert expected and tokens[
                index : index + len(javascript_tokens(expected))
            ] == javascript_tokens(expected), "Unsupported createRequire loader"
        if value == "require" and after[:1] == [("punct", "(")]:
            imports.append(literal(index + 2))
            assert tokens[index + 3 : index + 4] == [("punct", ")")], (
                "Computed require is unsupported"
            )
        if value == "import":
            if after[:2] == [("punct", "."), ("word", "meta")]:
                continue
            if after[:1] == [("punct", "(")]:
                if len(after) > 2 and after[1][0] == "string":
                    imports.append(literal(index + 2))
                    assert after[2] == ("punct", ")"), "Computed import is unsupported"
                else:
                    # Existing core behavior: the only computed import selects two
                    # built-in transports, never a package or archive module.
                    expected = javascript_tokens(
                        'import(protocol === "https:" ? "node:https" : "node:http")'
                    )
                    assert (
                        filename == "package/dist/transport.js"
                        and tokens[index : index + len(expected)] == expected
                    ), "Computed import is unsupported"
                continue
            if after and after[0][0] == "string":
                imports.append(literal(index + 1))
                continue
            cursor = index + 1
            while cursor < len(tokens) and tokens[cursor] != ("word", "from"):
                assert tokens[cursor][0] == "word" or tokens[cursor][1] in {
                    "{",
                    "}",
                    ",",
                    "*",
                }, "Unsupported static import syntax"
                cursor += 1
            assert cursor < len(tokens), "Missing static import source"
            imports.append(literal(cursor + 1))
        elif value == "export" and after and after[0][1] in {"{", "*"}:
            cursor = index + 1
            while cursor < len(tokens) and tokens[cursor][1] not in {"from", ";"}:
                assert tokens[cursor][0] == "word" or tokens[cursor][1] in {
                    "{",
                    "}",
                    ",",
                    "*",
                }, "Unsupported re-export syntax"
                cursor += 1
            assert cursor < len(tokens), "Unterminated re-export"
            if tokens[cursor][1] == "from":
                imports.append(literal(cursor + 1))
    return imports


def inspect_setup_parser_boundary(files: dict[str, bytes], metadata: dict) -> None:
    assert metadata.get("dependencies", {}).get(SETUP_PARSER) == SETUP_PARSER_VERSION, (
        "Setup parser dependency must use the reviewed exact version"
    )
    assert SETUP_PARSER_MODULE in files, "Missing setup parser module"
    parser_source = files[SETUP_PARSER_MODULE].decode("utf-8")
    assert parser_source.startswith('import { parse } from "@babel/parser";\n'), (
        "Missing canonical setup-only parser import"
    )
    assert parser_source.count(SETUP_PARSER) == 1, "Unexpected setup parser reference"

    def setup_module(path):
        return path == "package/dist/setup.js" or path.startswith("package/dist/setup/")

    for field in ("main", "module", "browser"):
        if field in metadata:
            target = metadata[field]
            assert isinstance(target, str) and not setup_module(
                "package/" + target.removeprefix("./")
            ), "Non-setup entrypoint reaches setup implementation"
    for export, entry in metadata["exports"].items():
        targets = entry.values() if isinstance(entry, dict) else (entry,)
        if export != "./setup":
            assert all(
                not setup_module("package/" + target.removeprefix("./"))
                for target in targets
            ), "Non-setup export reaches setup implementation"
    for name, data in files.items():
        if not name.endswith((".js", ".mjs", ".cjs")):
            continue
        source = data.decode("utf-8")
        if name != SETUP_PARSER_MODULE:
            assert SETUP_PARSER not in source, (
                "Parser reference outside setup parser module"
            )
        for specifier in module_imports(source, name):
            if specifier.startswith(SETUP_PARSER):
                assert name == SETUP_PARSER_MODULE and specifier == SETUP_PARSER, (
                    "Parser import outside setup parser module"
                )
            if setup_module(name):
                continue
            if specifier.startswith("."):
                target = posixpath.normpath(
                    posixpath.join(posixpath.dirname(name), specifier)
                )
                assert target.startswith("package/") and target in files, (
                    "Missing or unsafe archive import"
                )
                assert not setup_module(target), (
                    "Non-setup module reaches setup implementation"
                )
            else:
                assert not specifier.startswith(("/", "file:", "data:", "#")), (
                    "Unsupported module origin"
                )
                assert specifier != "@hue-run/sdk/setup" and not specifier.startswith(
                    "@hue-run/sdk/dist/setup"
                ), "Non-setup module reaches setup implementation"


def read_url(url: str) -> bytes:
    with urlopen(
        Request(url, headers={"User-Agent": "hue-sdk-release"}), timeout=30
    ) as response:
        return response.read()


def entries(path: Path) -> dict[str, bytes]:
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            return {
                name: archive.read(name)
                for name in archive.namelist()
                if not name.endswith("/")
            }
    with tarfile.open(path) as archive:
        assert all(not item.issym() and not item.islnk() for item in archive), (
            "Unexpected archive link"
        )
        return {
            item.name: archive.extractfile(item).read()
            for item in archive
            if item.isfile()
        }


def inspect(path: Path, language: str, version: str) -> None:
    files = entries(path)
    assert files, "Empty archive"
    for name, data in files.items():
        parts = PurePosixPath(name).parts
        assert not name.startswith("/") and ".." not in parts, "Unsafe archive path"
        assert not any(
            part in {".git", ".hue", ".npmrc", ".pypirc", "node_modules", ".venv"}
            or part.startswith(".env")
            for part in parts
        ), "Private file in archive"
        assert not re.search(
            rb"hue_(?:sk_(?:live|test)|setup_(?:live|test)|install|claim)_[A-Za-z0-9_-]+"
            rb"|/setup/claim#[A-Za-z0-9_-]+"
            rb"|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
            data,
            re.IGNORECASE,
        ), "Credential-like content in archive"
    assert any(PurePosixPath(name).name.startswith("LICENSE") for name in files), (
        "Missing license file"
    )
    if language == "typescript":
        metadata = json.loads(files["package/package.json"])
        assert metadata["name"] == "@hue-run/sdk" and metadata["version"] == version
        assert metadata.get("private") is not True
        assert metadata.get("license") not in (None, "UNLICENSED")
        assert metadata.get("publishConfig", {}).get("access") == "public"
        dependencies = metadata.get("dependencies", {})
        core = sorted(name for name in dependencies if name != SETUP_PARSER)
        assert all(name.startswith("@opentelemetry/") for name in core), (
            f"Core tracing dependencies must be OpenTelemetry packages: {core}"
        )
        if SETUP_PARSER in dependencies or SETUP_PARSER_MODULE in files:
            inspect_setup_parser_boundary(files, metadata)
        assert not any(
            name in metadata.get("scripts", {})
            for name in (
                "preinstall",
                "install",
                "postinstall",
                "prepublishOnly",
                "publish",
                "postpublish",
            )
        )
        for entry in metadata["exports"].values():
            targets = entry.values() if isinstance(entry, dict) else (entry,)
            for target in targets:
                assert "package/" + target.removeprefix("./") in files, (
                    "Missing public export"
                )
    else:
        suffix = ".dist-info/METADATA" if path.suffix == ".whl" else "/PKG-INFO"
        metadata_files = [data for name, data in files.items() if name.endswith(suffix)]
        assert len(metadata_files) == 1, "Unexpected Python metadata inventory"
        metadata = BytesParser().parsebytes(metadata_files[0])
        assert metadata["Name"] == "hue-run" and metadata["Version"] == version
        license_value = metadata["License-Expression"] or metadata["License"]
        assert license_value and "UNLICENSED" not in license_value
        core = sorted(
            item
            for item in metadata.get_all("Requires-Dist") or []
            if "extra ==" not in item
        )
        assert all(re.match(r"(?:opentelemetry-|requests\b)", item) for item in core), (
            f"Core tracing dependencies must be OpenTelemetry packages or requests: {core}"
        )
    print(f"Inspected {path.name}: {len(files)} files")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("inspect", "registry"))
    parser.add_argument("language", choices=("typescript", "python"))
    parser.add_argument("version")
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    assert re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version), (
        "Public release must use a stable version"
    )
    filenames = (
        [f"hue-run-sdk-{args.version}.tgz"]
        if args.language == "typescript"
        else [
            f"hue_run-{args.version}-py3-none-any.whl",
            f"hue_run-{args.version}.tar.gz",
        ]
    )
    artifacts = [args.directory / name for name in filenames]
    if args.mode == "inspect":
        actual = {path.name for path in args.directory.iterdir() if path.is_file()}
        assert actual == set(filenames), (
            f"Unexpected artifact inventory: {sorted(actual)}"
        )
        records = []
        for path in artifacts:
            inspect(path, args.language, args.version)
            records.append(
                {
                    "filename": path.name,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "integrity": "sha512-"
                    + base64.b64encode(
                        hashlib.sha512(path.read_bytes()).digest()
                    ).decode("ascii"),
                }
            )
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True
        ).strip()
        manifest = {
            "commit": commit,
            "language": args.language,
            "version": args.version,
            "artifacts": records,
        }
        (args.directory / "release-manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n"
        )
        (args.directory / "SHA256SUMS").write_text(
            "".join(f"{item['sha256']}  {item['filename']}\n" for item in records)
        )
    else:
        manifest = json.loads((args.directory / "release-manifest.json").read_text())
        assert (
            manifest["language"] == args.language
            and manifest["version"] == args.version
        )
        if args.language == "typescript":
            metadata = json.loads(
                read_url(f"https://registry.npmjs.org/@hue-run%2fsdk/{args.version}")
            )
            urls = {filenames[0]: metadata["dist"]["tarball"]}
        else:
            metadata = json.loads(
                read_url(f"https://pypi.org/pypi/hue-run/{args.version}/json")
            )
            urls = {item["filename"]: item["url"] for item in metadata["urls"]}
        for item in manifest["artifacts"]:
            digest = hashlib.sha256(read_url(urls[item["filename"]])).hexdigest()
            assert digest == item["sha256"], (
                f"Registry bytes differ: {item['filename']}"
            )
            print(f"Registry SHA-256 verified: {item['filename']}")


if __name__ == "__main__":
    main()
