"""Fail when a public export is missing from the hosted API reference pages.

Public API is defined in VERSIONING.md: the runtime exports and exported types of the four
TypeScript entry points, and the names in each Python package's __all__.
"""

from __future__ import annotations

import ast
from pathlib import Path
import re
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TS = ROOT / "packages/sdk-typescript/src"
PY = ROOT / "packages/sdk-python/src/hue_sdk"


def fetch(url: str) -> str:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "hue-sdk-docs-check"}), timeout=30) as response:
        return response.read().decode("utf-8")


def ts_exports(entry: Path) -> set[str]:
    names: set[str] = set()
    text = entry.read_text()
    for block in re.findall(r"export\s+(?:type\s+)?\{([^}]*)\}", text):
        for item in block.split(","):
            item = item.strip()
            if not item or item.startswith("type *"):
                continue
            item = re.sub(r"^type\s+", "", item)
            names.add(item.split(" as ")[-1].strip())
    for star in re.findall(r"export\s+type\s+\*\s+from\s+\"([^\"]+)\"", text):
        target = (entry.parent / star.replace(".js", ".ts")).resolve()
        names |= set(re.findall(r"^export\s+(?:interface|type)\s+(\w+)", target.read_text(), re.M))
    return names


def py_all(module: Path) -> set[str]:
    tree = ast.parse(module.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "__all__" for t in node.targets):
            return {elt.value for elt in node.value.elts}  # type: ignore[attr-defined]
    return set()


def main() -> int:
    checks = {
        "https://docs.hue.run/reference/typescript.md": set().union(
            *(ts_exports(TS / name) for name in ("index.ts", "ai-sdk.ts", "evals.ts", "managed.ts"))
        ),
        "https://docs.hue.run/reference/python.md": set().union(
            *(py_all(PY / name) for name in ("__init__.py", "evals/__init__.py", "managed.py"))
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
        print(f"{url}: {len(names)} public names, {len(missing)} missing" + (f": {missing}" if missing else ""))
        ok = ok and not missing
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
