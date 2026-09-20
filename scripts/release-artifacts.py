"""Inspect release inventory and bind published bytes to the tested archives."""

from __future__ import annotations

import argparse
import base64
from email.parser import BytesParser
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
from urllib.request import Request, urlopen
import zipfile


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
        core = sorted(metadata.get("dependencies", {}))
        assert all(name.startswith("@opentelemetry/") for name in core), (
            f"Core tracing dependencies must be OpenTelemetry packages: {core}"
        )
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
            item for item in metadata.get_all("Requires-Dist") or [] if "extra ==" not in item
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
                    "integrity": "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode("ascii"),
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
