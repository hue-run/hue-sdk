"""Compare published documents with their unversioned copies on docs.hue.run.

COMPATIBILITY.md and skills/hue/SKILL.md are maintained in this repository and mirrored on the
documentation site. The site adds frontmatter, an index banner and table padding; those are
normalized away before comparing. Exit 1 when the prose differs so the mirror can be updated.

When this tree is an unpublished candidate, compare the hosted pages to hue-run/docs
instead of the working tree or the last package tag. The skill and compatibility mirrors
can move on the documentation site between SDK publishes, so a tag pin would fail a
correctly updated hosted page.
"""

from __future__ import annotations

import difflib
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NPM_LATEST = "https://registry.npmjs.org/@hue-run%2Fsdk/latest"
DOCS_RAW = "https://raw.githubusercontent.com/hue-run/docs"


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


def typescript_version(contract_text: str | None = None) -> str:
    payload = json.loads(contract_text if contract_text is not None else (ROOT / "docs-contract.json").read_text())
    version = payload["packages"]["typescript"]["version"]
    if not isinstance(version, str) or not version:
        raise ValueError("TypeScript package version is missing")
    return version


def npm_latest_version() -> str:
    version = json.loads(fetch(NPM_LATEST))["version"]
    if not isinstance(version, str) or not version:
        raise ValueError("npm latest version is unavailable")
    return version


def docs_file(path: str) -> str:
    return fetch(f"{DOCS_RAW}/main/{path}")


def source_labels(working: str, published: str) -> dict[str, str]:
    if working == published:
        return {
            "compatibility": "COMPATIBILITY.md",
            "skill": "skills/hue/SKILL.md",
        }
    return {
        "compatibility": "hue-run/docs/sdks/compatibility.mdx",
        "skill": "hue-run/docs/skill.md",
    }


def frontmatter_title(text: str) -> str | None:
    if not text.startswith("---\n"):
        return None
    frontmatter = text.split("---", 2)[1]
    match = re.search(r"^title:\s*[\"']?([^\"'\n]+)[\"']?\s*$", frontmatter, re.M)
    return match.group(1).strip() if match else None


def drop_page_title(lines: list[str], titles: set[str]) -> list[str]:
    if lines and lines[0] in titles:
        return lines[1:]
    return lines


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


def compare(name: str, ours_text: str, ours_label: str, url: str) -> bool:
    hosted_text = fetch(url)
    if name == "skill" and skill_metadata(ours_text) != skill_metadata(hosted_text):
        print(
            f"skill: hosted metadata {skill_metadata(hosted_text)} differs from "
            f"repository metadata {skill_metadata(ours_text)}"
        )
        return False
    titles = {title for title in (frontmatter_title(ours_text), frontmatter_title(hosted_text)) if title}
    ours = drop_page_title(normalize(ours_text), titles)
    theirs = drop_page_title(normalize(hosted_text), titles)
    diff = list(
        difflib.unified_diff(
            theirs,
            ours,
            fromfile=url,
            tofile=ours_label,
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


def document_sources() -> dict[str, tuple[str, str]]:
    published = npm_latest_version()
    working = typescript_version()
    labels = source_labels(working, published)
    if working == published:
        return {
            "compatibility": ((ROOT / "COMPATIBILITY.md").read_text(), labels["compatibility"]),
            "skill": ((ROOT / "skills/hue/SKILL.md").read_text(), labels["skill"]),
        }
    print(
        f"working tree is TypeScript {working}; "
        f"comparing hosted docs to hue-run/docs (npm latest is {published})"
    )
    return {
        "compatibility": (docs_file("sdks/compatibility.mdx"), labels["compatibility"]),
        "skill": (docs_file("skill.md"), labels["skill"]),
    }


def main() -> int:
    sources = document_sources()
    checks = [
        ("compatibility", sources["compatibility"], "https://docs.hue.run/sdks/compatibility.md"),
        ("skill", sources["skill"], "https://docs.hue.run/skill.md"),
    ]
    ok = True
    for name, (ours_text, ours_label), url in checks:
        try:
            ok = compare(name, ours_text, ours_label, url) and ok
        except Exception as error:  # network or HTTP failure
            print(f"{name}: could not fetch {url}: {error}")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
