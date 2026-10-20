"""Compare published documents with their unversioned copies on docs.hue.run.

COMPATIBILITY.md and skills/hue/SKILL.md are maintained in this repository and mirrored on the
documentation site. The site adds frontmatter, an index banner, table padding and a footer; those
are normalized away before comparing. Exit 1 when the prose differs so the mirror can be updated.

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
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NPM_LATEST = "https://registry.npmjs.org/@hue-run%2Fsdk/latest"
DOCS_RAW = "https://raw.githubusercontent.com/hue-run/docs"
# The attribution Mintlify appends to every Markdown export.
SITE_FOOTER = re.compile(
    r"This documentation is built and hosted on \[Mintlify\]\([^)]*\), a developer documentation platform\."
)


def frontmatter_value(frontmatter: str, key: str, indented: bool = False) -> str | None:
    """Read one plain, double-quoted or single-quoted scalar from YAML frontmatter.

    A quoted value keeps the other quote character, as a description with an apostrophe does.
    """
    indent = r"[ \t]+" if indented else ""
    match = re.search(rf"^{indent}{key}:[ \t]*(.*?)[ \t]*$", frontmatter, re.M)
    if not match:
        return None
    value = match.group(1)
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].replace("''", "'") if value[0] == "'" else value[1:-1]
    return value.strip() or None


def skill_metadata(text: str) -> dict[str, str]:
    """Read the public skill identity while allowing Mintlify's extra frontmatter."""

    if not text.startswith("---\n"):
        raise ValueError("skill is missing YAML frontmatter")
    frontmatter = text.split("---", 2)[1]
    fields: dict[str, str] = {}
    for key in ("name", "description", "author", "version"):
        value = frontmatter_value(frontmatter, key, indented=key in {"author", "version"})
        if value is None:
            raise ValueError(f"skill frontmatter is missing {key}")
        fields[key] = value
    return fields


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "hue-sdk-docs-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def hosted_url(url: str) -> str:
    """The unversioned URL under a query no page links, so the fetch reads the current deployment.

    The CDN keeps `/skill.md` for up to a day and a docs deploy does not refresh it, so a plain
    fetch reports a mirror that is already deployed as drift. A fresh query is a cache key no
    reader shares; the `?v=<version>` keys the docs link are left alone.
    """
    return f"{url}?drift-check={time.time_ns()}"


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
    return frontmatter_value(text.split("---", 2)[1], "title")


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
        if not line or line.startswith(">") or SITE_FOOTER.fullmatch(line):
            continue
        if re.fullmatch(r"\|[\s:|-]+\|", line):
            line = "|---|"
        line = re.sub(r"\]\([^)]*\)", "]", line)  # link targets differ between site and repo
        line = re.sub(r"^#+\s*", "", line)  # heading levels differ between site and repo
        line = re.sub(r"\s*\|\s*", " | ", line)
        line = re.sub(r"\s+", " ", line).strip()
        lines.append(line)
    return lines


def skill_body_changed_without_version_bump(ours_text: str, hosted_text: str) -> bool:
    """True when the skill's prose differs from the hosted copy under the same metadata.version.

    The hosted route is cached under `skill.md?v=<version>`, so a body change that keeps its
    version would keep serving the old body under the key the docs link. Only the body counts:
    the frontmatter is compared by `skill_metadata`.
    """
    ours_meta, hosted_meta = skill_metadata(ours_text), skill_metadata(hosted_text)
    if ours_meta["version"] != hosted_meta["version"]:
        return False
    titles = {
        title for title in (frontmatter_title(ours_text), frontmatter_title(hosted_text)) if title
    }
    ours = drop_page_title(normalize(ours_text), titles)
    theirs = drop_page_title(normalize(hosted_text), titles)
    return ours != theirs


def compare(name: str, ours_text: str, ours_label: str, url: str) -> bool:
    hosted_text = fetch(hosted_url(url))
    if name == "skill" and skill_metadata(ours_text) != skill_metadata(hosted_text):
        print(
            f"skill: hosted metadata {skill_metadata(hosted_text)} differs from "
            f"repository metadata {skill_metadata(ours_text)}"
        )
        return False
    if name == "skill" and skill_body_changed_without_version_bump(ours_text, hosted_text):
        print(
            f"skill: the body differs from {url} but metadata.version is still "
            f"{skill_metadata(ours_text)['version']}; bump the version so skill.md?v=<version> "
            "serves the new body"
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
        except Exception as error:  # network, HTTP or frontmatter failure
            print(f"{name}: could not check {url}: {error}")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
