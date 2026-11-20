"""Fail when a published public export is missing from hosted API reference pages.

Exports added on main after the typescript-v<version> tag keep that version until
the next release. Hosted docs are checked against the tag, not those names.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NPM_LATEST = "https://registry.npmjs.org/@hue-run%2Fsdk/latest"
PUBLISHED_CONTRACT = "https://raw.githubusercontent.com/hue-run/docs/main/contracts/sdk-docs.json"
RELEASED_CONTRACT = (
    "https://raw.githubusercontent.com/hue-run/hue-sdk/typescript-v{version}/docs-contract.json"
)


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "hue-sdk-docs-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def released_contract_url(version: str) -> str:
    return RELEASED_CONTRACT.format(version=version)


def export_names(contract: dict) -> dict[str, set[str]]:
    packages = contract["packages"]
    return {
        "typescript": set().union(
            *(entry["publicExports"] for entry in packages["typescript"]["entrypoints"].values())
        ),
        "python": set().union(
            *(module["publicExports"] for module in packages["python"]["modules"].values())
        ),
    }


def select_hosted_contract(
    local: dict, npm_version: str, published: dict | None, released: dict | None
) -> dict:
    """Pick the contract hosted reference pages have to cover.

    A newer working-tree version is an unpublished candidate: use the docs repo
    snapshot that matches npm. The same version can still add exports after the
    GitHub release tag; those names are not published, so use the tag.
    """
    local_version = local["packages"]["typescript"]["version"]
    if local_version != npm_version:
        if published is None:
            raise RuntimeError("published docs contract is missing")
        published_version = published["packages"]["typescript"]["version"]
        if published_version != npm_version:
            raise RuntimeError(
                f"docs SDK snapshot is TypeScript {published_version}, npm latest is {npm_version}"
            )
        return published
    if released is not None and export_names(released) != export_names(local):
        released_version = released["packages"]["typescript"]["version"]
        if released_version != npm_version:
            raise RuntimeError(
                f"typescript-v{npm_version} contract is TypeScript {released_version}"
            )
        return released
    return local


def published_contract() -> dict:
    local = json.loads((ROOT / "docs-contract.json").read_text())
    local_version = local["packages"]["typescript"]["version"]
    npm_version = json.loads(fetch(NPM_LATEST))["version"]
    published = None
    released = None
    if local_version != npm_version:
        print(
            f"working tree is TypeScript {local_version}; "
            f"checking hosted reference against published {npm_version}"
        )
        published = json.loads(fetch(PUBLISHED_CONTRACT))
    else:
        # shortcut: the typescript-v tag may lag npm until registry acceptance, read the tarball if that window fails the job
        released = json.loads(fetch(released_contract_url(npm_version)))
    selected = select_hosted_contract(local, npm_version, published, released)
    if selected is released:
        print(
            f"working tree adds public exports after typescript-v{npm_version}; "
            f"checking hosted reference against that release"
        )
    return selected


def main() -> int:
    contract = published_contract()
    if contract.get("schemaVersion") != 1:
        print("docs-contract.json: unsupported schemaVersion")
        return 1
    names = export_names(contract)
    checks = {
        "https://docs.hue.run/reference/typescript.md": names["typescript"],
        "https://docs.hue.run/reference/python.md": names["python"],
    }
    ok = True
    for url, required in checks.items():
        try:
            page = fetch(url)
        except Exception as error:
            print(f"could not fetch {url}: {error}")
            ok = False
            continue
        missing = sorted(name for name in required if not re.search(rf"\b{re.escape(name)}\b", page))
        suffix = f": {missing}" if missing else ""
        print(f"{url}: {len(required)} public names, {len(missing)} missing{suffix}")
        ok = ok and not missing
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
