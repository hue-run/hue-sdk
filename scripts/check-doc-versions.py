"""Fail when tracked Markdown mentions a stale package version.

The current versions come from package.json and pyproject.toml. Historical mentions are
allowed in CHANGELOG.md and in "requires/available in" notes that name the release a feature
first shipped in; everything else must match the relevant package's current version or use a
placeholder. TypeScript and Python versions are checked independently once they diverge.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
# RELEASING.md shows historical release commands as worked examples.
ALLOWED_FILES = {"CHANGELOG.md", "RELEASING.md"}
# Sentences that legitimately name the release a feature first appeared in.
ALLOWED_CONTEXT = re.compile(
    r"(requires?|available in|since|added in|older|shipped in|0\.1\.0\.dev0|pilot"
    r"|OpenInference|instrumentation|dependency from|for example|unreleased|next releases?|published|^\s*version:)",
    re.I,
)


def current_versions() -> dict[str, str]:
    ts = json.loads((ROOT / "packages/sdk-typescript/package.json").read_text())["version"]
    py = tomllib.loads((ROOT / "packages/sdk-python/pyproject.toml").read_text())["project"]["version"]
    return {"typescript": ts, "python": py}


def languages_for(name: str, line: str) -> set[str]:
    """Return the package languages a Markdown line is describing."""

    if name.startswith(("packages/sdk-typescript/", "packages/aliases/npm-hue-run/")):
        return {"typescript"}
    if name.startswith(("packages/sdk-python/", "packages/aliases/pypi-hue-sdk/")):
        return {"python"}
    languages: set[str] = set()
    if re.search(r"TypeScript|@hue-run/sdk|\bnpm\b|runLocalAgent", line, re.I):
        languages.add("typescript")
    if re.search(r"Python|hue_sdk|\bPyPI\b|`hue-run`", line, re.I):
        languages.add("python")
    return languages


def stale_mentions(name: str, text: str, versions: dict[str, str]) -> list[str]:
    """Return stale-version diagnostics for one tracked Markdown document."""

    problems: list[str] = []
    for number, line in enumerate(text.splitlines(), start=1):
        languages = languages_for(name, line)
        expected = {versions[language] for language in languages} or set(versions.values())
        # Hue is pre-1.0 and currently uses one-digit minor lines. Excluding 0.0.x
        # and multi-digit minors avoids mistaking fixture/tool versions for SDKs.
        for match in re.finditer(r"\b0\.[1-9]\.\d+\b", line):
            value = match.group(0)
            if value in expected or ALLOWED_CONTEXT.search(line):
                continue
            problems.append(f"{name}:{number}: stale version {value}: {line.strip()[:100]}")
    return problems


def main() -> int:
    versions = current_versions()
    files = subprocess.check_output(["git", "ls-files", "*.md", "**/*.md"], cwd=ROOT, text=True).split()
    problems: list[str] = []
    for name in sorted(set(files)):
        if Path(name).name in ALLOWED_FILES:
            continue
        problems.extend(stale_mentions(name, (ROOT / name).read_text(), versions))
    for problem in problems:
        print(problem)
    print(f"current versions: {versions}; {len(problems)} stale mention(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
