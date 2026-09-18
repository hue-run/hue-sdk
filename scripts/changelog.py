"""Read per-package CHANGELOG.md sections for the release gate and GitHub release notes."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

SECTIONS = {"typescript": "## @hue-run/sdk (TypeScript)", "python": "## hue-run (Python)"}
TITLES = {"typescript": "TypeScript SDK", "python": "Python SDK"}


def section(changelog: str, language: str, version: str) -> str:
    """Return the body of the `### [version]` entry inside the language's section."""
    heading = SECTIONS[language]
    start = changelog.find(heading + "\n")
    assert start != -1, f"CHANGELOG.md lacks the section {heading!r}"
    end = changelog.find("\n## ", start + len(heading))
    package = changelog[start : end if end != -1 else None]
    pattern = re.compile(
        rf"^### \[{re.escape(version)}\](?:\([^)]*\))? - \d{{4}}-\d{{2}}-\d{{2}}\n(.*?)(?=^### |\Z)",
        re.M | re.S,
    )
    match = pattern.search(package)
    assert match, f"CHANGELOG.md lacks a `### [{version}]` entry under {heading!r}"
    body = match.group(1).strip()
    assert body, f"CHANGELOG.md entry for {language} {version} is empty"
    return body


def notes(changelog: str, language: str, version: str, commit: str, run_url: str, sums: str) -> str:
    rows = "\n".join(
        f"| `{filename}` | `{digest}` |"
        for digest, filename in (line.split() for line in sums.strip().splitlines())
    )
    registry = (
        f"[npm](https://www.npmjs.com/package/@hue-run/sdk/v/{version})"
        if language == "typescript"
        else f"[PyPI](https://pypi.org/project/hue-run/{version}/)"
    )
    name = "@hue-run/sdk" if language == "typescript" else "hue-run"
    return (
        f"`{name}` {version} is available on {registry}.\n\n"
        f"{section(changelog, language, version)}\n\n"
        f"## Verification\n\n"
        f"Built once from commit `{commit}` by [this release run]({run_url}), tested as an installed "
        f"package, published as unchanged bytes through GitHub OIDC trusted publishing, and re-verified "
        f"from the public registry. The attached manifest and checksums preserve the tested release.\n\n"
        f"| Artifact | SHA-256 |\n| --- | --- |\n{rows}\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    for mode in ("section", "notes"):
        command = sub.add_parser(mode)
        command.add_argument("language", choices=sorted(SECTIONS))
        command.add_argument("version")
        if mode == "notes":
            command.add_argument("commit")
            command.add_argument("run_url")
            command.add_argument("sha256sums", type=Path)
    args = parser.parse_args()
    changelog = (Path(__file__).resolve().parents[1] / "CHANGELOG.md").read_text()
    if args.mode == "section":
        sys.stdout.write(section(changelog, args.language, args.version) + "\n")
    else:
        sys.stdout.write(
            notes(
                changelog,
                args.language,
                args.version,
                args.commit,
                args.run_url,
                args.sha256sums.read_text(),
            )
        )


if __name__ == "__main__":
    main()
