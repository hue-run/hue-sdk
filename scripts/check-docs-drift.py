"""Compare repository-canonical documents with their copies on docs.hue.run.

COMPATIBILITY.md and skills/hue/SKILL.md are maintained in this repository and mirrored on the
documentation site. The site adds frontmatter, an index banner and table padding; those are
normalized away before comparing. Exit 1 when the prose differs so the mirror can be updated.
"""

from __future__ import annotations

import difflib
from pathlib import Path
import re
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def fetch(url: str) -> str:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "hue-sdk-docs-check"}), timeout=30) as response:
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
    ours = normalize(local.read_text())
    theirs = normalize(fetch(url))
    diff = list(difflib.unified_diff(theirs, ours, fromfile=url, tofile=str(local.relative_to(ROOT)), lineterm="", n=0))
    if diff:
        print(f"{name}: {len([d for d in diff if d[:1] in '+-' and d[:3] not in ('+++', '---')])} differing line(s)")
        print("\n".join(diff[:80]))
        return False
    print(f"{name}: in sync with {url}")
    return True


def main() -> int:
    skill = (ROOT / "skills/hue/SKILL.md").read_text()
    version = re.search(r'^\s+version:\s+"([^"]+)"', skill, re.M).group(1)
    checks = [
        ("compatibility", ROOT / "COMPATIBILITY.md", "https://docs.hue.run/sdks/compatibility.md"),
        ("skill", ROOT / "skills/hue/SKILL.md", f"https://docs.hue.run/skill.md?v={version}"),
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
