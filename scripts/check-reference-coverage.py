"""Fail when a contracted public export is missing from hosted API reference pages."""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "hue-sdk-docs-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def main() -> int:
    contract = json.loads((ROOT / "docs-contract.json").read_text())
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
