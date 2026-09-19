"""Compare repository-canonical documents with their unversioned copies on docs.hue.run.

COMPATIBILITY.md and skills/hue/SKILL.md are maintained in this repository and mirrored on the
documentation site. The site adds frontmatter, an index banner and table padding; those are
normalized away before comparing. Exit 1 when the prose differs so the mirror can be updated.
"""

from __future__ import annotations

import difflib
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def skill_metadata(text: str) -> dict[str, str]:
    """Read the public skill identity while allowing Mintlify's extra frontmatter."""

    if not text.startswith("---\n"):
        raise ValueError("skill is missing YAML frontmatter")
    frontmatter = text.split("---", 2)[1]
    fields: dict[str, str] = {}
    for key in ("name", "description", "author", "version"):
        indent = r"\s+" if key in {"author", "version"} else ""
        match = re.search(rf"^{indent}{key}:\s*[\"']?([^\"'\n]+)[\"']?\s*$", frontmatter, re.M)
        if not match:
            raise ValueError(f"skill frontmatter is missing {key}")
        fields[key] = match.group(1).strip()
    return fields


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "hue-sdk-docs-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def normalize(text: str) -> list[str]:
    lines: list[str] = []
    in_frontmatter = False
    for index, raw in enumerate(text.splitlines()):
        if index == 0 and raw.strip() == "---":
            in_frontmatter = True
            continue
        if in_frontmatter:
            if raw.strip() == "---":
                in_frontmatter = False
            continue
        line = raw.strip()
        if not line or line.startswith(">"):
            continue
        if re.fullmatch(r"\|[\s:|-]+\|", line):
            line = "|---|"
        line = re.sub(r"\]\([^)]*\)", "]", line)  # link targets differ between site and repo
        line = re.sub(r"^#+\s*", "", line)  # heading levels differ between site and repo
        line = re.sub(r"\s*\|\s*", " | ", line)
        line = re.sub(r"\s+", " ", line).strip()
        lines.append(line)
    return lines


def compare(name: str, local: Path, url: str) -> bool:
    local_text = local.read_text()
    hosted_text = fetch(url)
    if name == "skill" and skill_metadata(local_text) != skill_metadata(hosted_text):
        print(
            f"skill: hosted metadata {skill_metadata(hosted_text)} differs from "
            f"repository metadata {skill_metadata(local_text)}"
        )
        return False
    ours = normalize(local_text)
    theirs = normalize(hosted_text)
    diff = list(
        difflib.unified_diff(
            theirs,
            ours,
            fromfile=url,
            tofile=str(local.relative_to(ROOT)),
            lineterm="",
            n=0,
        )
    )
    if diff:
        differences = len([d for d in diff if d[:1] in "+-" and d[:3] not in ("+++", "---")])
        print(f"{name}: {differences} differing line(s)")
        print("\n".join(diff[:80]))
        return False
    print(f"{name}: in sync with {url}")
    return True


def main() -> int:
    checks = [
        ("compatibility", ROOT / "COMPATIBILITY.md", "https://docs.hue.run/sdks/compatibility.md"),
        ("skill", ROOT / "skills/hue/SKILL.md", "https://docs.hue.run/skill.md"),
    ]
    ok = True
    for name, local, url in checks:
        try:
            ok = compare(name, local, url) and ok
        except Exception as error:  # network or HTTP failure
            print(f"{name}: could not fetch {url}: {error}")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
