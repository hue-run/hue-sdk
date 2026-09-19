"""Fail when a contracted public export is missing from hosted API reference pages."""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NPM_LATEST = "https://registry.npmjs.org/@hue-run%2Fsdk/latest"
PUBLISHED_CONTRACT = "https://raw.githubusercontent.com/hue-run/docs/main/contracts/sdk-docs.json"


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "hue-sdk-docs-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def published_contract() -> dict:
    local = json.loads((ROOT / "docs-contract.json").read_text())
    local_version = local["packages"]["typescript"]["version"]
    npm_version = json.loads(fetch(NPM_LATEST))["version"]
    if local_version == npm_version:
        return local
    print(
        f"working tree is TypeScript {local_version}; "
        f"checking hosted reference against published {npm_version}"
    )
    published = json.loads(fetch(PUBLISHED_CONTRACT))
    published_version = published["packages"]["typescript"]["version"]
    if published_version != npm_version:
        raise RuntimeError(
            f"docs SDK snapshot is TypeScript {published_version}, npm latest is {npm_version}"
        )
    return published


def main() -> int:
    contract = published_contract()
    if contract.get("schemaVersion") != 1:
        print("docs-contract.json: unsupported schemaVersion")
        return 1
    checks = {
        "https://docs.hue.run/reference/typescript.md": set().union(
            *(
                entry["publicExports"]
                for entry in contract["packages"]["typescript"]["entrypoints"].values()
            )
        ),
        "https://docs.hue.run/reference/python.md": set().union(
            *(
                module["publicExports"]
                for module in contract["packages"]["python"]["modules"].values()
            )
        ),
    }
    ok = True
    for url, names in checks.items():
        try:
            page = fetch(url)
        except Exception as error:
            print(f"could not fetch {url}: {error}")
            ok = False
            continue
        missing = sorted(name for name in names if not re.search(rf"\b{re.escape(name)}\b", page))
        suffix = f": {missing}" if missing else ""
        print(f"{url}: {len(names)} public names, {len(missing)} missing{suffix}")
        ok = ok and not missing
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
