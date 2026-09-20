"""Generate the public, deterministic SDK documentation contract.

The contract is intentionally limited to public repository state that downstream
documentation can mirror: released package identities, declared public exports,
the compatibility matrix, and the portable skill's public metadata. It contains
no build timestamps, commit identities, internal links, or deployment details.
"""

from __future__ import annotations

import argparse
import ast
import difflib
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import tomllib

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "docs-contract.json"
TS_SOURCE = ROOT / "packages/sdk-typescript/src"
PY_SOURCE = ROOT / "packages/sdk-python/src/hue_sdk"


def sha256(path: Path) -> str:
    """Return the content identity used by documentation mirrors."""

    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def typescript_exports(entry: Path) -> list[str]:
    """Read the names exported by one public TypeScript entry point."""

    text = entry.read_text()
    names: set[str] = set()

    for match in re.finditer(
        r"^export\s+(?:type\s+)?\{(?P<body>.*?)\}\s+from\s+[\"'][^\"']+[\"'];?",
        text,
        re.MULTILINE | re.DOTALL,
    ):
        for raw in match.group("body").split(","):
            item = re.sub(r"/\*.*?\*/", "", raw, flags=re.DOTALL).strip()
            item = re.sub(r"^type\s+", "", item)
            if item:
                names.add(re.split(r"\s+as\s+", item)[-1].strip())

    for target_name in re.findall(
        r"^export\s+type\s+\*\s+from\s+[\"']([^\"']+)[\"'];?", text, re.MULTILINE
    ):
        target = (entry.parent / target_name.replace(".js", ".ts")).resolve()
        names.update(typescript_declared_type_exports(target))

    names.update(
        re.findall(
            r"^export\s+(?:(?:declare|abstract|async)\s+)*(?:class|function|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)",
            text,
            re.MULTILINE,
        )
    )
    return sorted(names)


def typescript_declared_type_exports(source: Path) -> set[str]:
    """Read type-space declarations reached by an ``export type *``."""

    text = source.read_text()
    names = set(
        re.findall(
            r"^export\s+(?:(?:declare|abstract)\s+)*(?:interface|type|class|enum)\s+([A-Za-z_$][\w$]*)",
            text,
            re.MULTILINE,
        )
    )
    for match in re.finditer(
        r"^export\s+type\s+\{(?P<body>.*?)\}\s+from\s+[\"'][^\"']+[\"'];?",
        text,
        re.MULTILINE | re.DOTALL,
    ):
        for raw in match.group("body").split(","):
            item = re.sub(r"/\*.*?\*/", "", raw, flags=re.DOTALL).strip()
            if item:
                names.add(re.split(r"\s+as\s+", item)[-1].strip())
    for target_name in re.findall(
        r"^export\s+type\s+\*\s+from\s+[\"']([^\"']+)[\"'];?", text, re.MULTILINE
    ):
        target = (source.parent / target_name.replace(".js", ".ts")).resolve()
        names.update(typescript_declared_type_exports(target))
    return names


def python_exports(module: Path) -> list[str]:
    """Read the literal ``__all__`` that defines a public Python module."""

    tree = ast.parse(module.read_text(), filename=str(module))
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if not any(isinstance(target, ast.Name) and target.id == "__all__" for target in targets):
            continue
        values = ast.literal_eval(node.value)
        if not isinstance(values, (list, tuple)) or not all(
            isinstance(value, str) for value in values
        ):
            raise ValueError(f"{module}: __all__ must be a literal list of strings")
        return sorted(values)
    raise ValueError(f"{module}: public module has no literal __all__")


def skill_frontmatter(path: Path) -> dict[str, Any]:
    """Parse the deliberately small public subset of the skill frontmatter."""

    lines = path.read_text().splitlines()
    if not lines or lines[0] != "---":
        raise ValueError(f"{path}: missing YAML frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise ValueError(f"{path}: unterminated YAML frontmatter") from error

    top: dict[str, str] = {}
    metadata: dict[str, str] = {}
    in_metadata = False
    for line in lines[1:end]:
        if line == "metadata:":
            in_metadata = True
            continue
        match = re.fullmatch(r"(\s*)([A-Za-z][\w-]*):\s*(.+)", line)
        if not match:
            continue
        indent, key, raw = match.groups()
        value = raw.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if in_metadata and indent:
            metadata[key] = value
        elif not indent:
            in_metadata = False
            top[key] = value

    required = ("name", "description")
    missing_top = any(key not in top for key in required)
    missing_metadata = any(key not in metadata for key in ("author", "version"))
    if missing_top or missing_metadata:
        raise ValueError(f"{path}: missing public skill metadata")
    return {
        "name": top["name"],
        "description": top["description"],
        "metadata": {"author": metadata["author"], "version": metadata["version"]},
    }


def compatibility_metadata(path: Path, root: Path = ROOT) -> dict[str, Any]:
    """Extract the public compatibility sections and primary support matrix."""

    text = path.read_text()
    sections = re.findall(r"^##\s+(.+?)\s*$", text, re.MULTILINE)
    lines = text.splitlines()
    header = "| Path | Verified support | Boundary |"
    try:
        start = lines.index(header)
    except ValueError as error:
        raise ValueError(f"{path}: primary compatibility matrix is missing") from error

    matrix: list[dict[str, str]] = []
    for line in lines[start + 2 :]:
        if not line.startswith("|"):
            break
        cells = [re.sub(r"\s+", " ", cell.strip()) for cell in line.strip().strip("|").split("|")]
        if len(cells) != 3:
            raise ValueError(f"{path}: compatibility row must have exactly three columns: {line}")
        matrix.append({"path": cells[0], "verifiedSupport": cells[1], "boundary": cells[2]})
    if not matrix:
        raise ValueError(f"{path}: primary compatibility matrix has no rows")
    return {
        "source": str(path.relative_to(root)),
        "sha256": sha256(path),
        "sections": sections,
        "matrix": matrix,
    }


def build_contract(root: Path = ROOT) -> dict[str, Any]:
    """Build the contract solely from canonical repository sources."""

    ts_manifest_path = root / "packages/sdk-typescript/package.json"
    py_manifest_path = root / "packages/sdk-python/pyproject.toml"
    compatibility_path = root / "COMPATIBILITY.md"
    skill_path = root / "skills/hue/SKILL.md"
    ts_source = root / "packages/sdk-typescript/src"
    py_source = root / "packages/sdk-python/src/hue_sdk"

    ts_manifest = json.loads(ts_manifest_path.read_text())
    py_manifest = tomllib.loads(py_manifest_path.read_text())["project"]
    ts_entry_files = {
        ".": "index.ts",
        "./ai-sdk": "ai-sdk.ts",
        "./environment": "environment.ts",
        "./evals": "evals.ts",
        "./managed": "managed.ts",
        "./setup": "setup.ts",
        "./evals/conversion-outcome-core.mjs": "evals/conversion-outcome-core.d.mts",
    }
    ts_schema_exports = {"./setup-events.schema.json"}
    declared_entrypoints = set(ts_manifest["exports"]) - {"./package.json"}
    if declared_entrypoints != set(ts_entry_files) | ts_schema_exports:
        raise ValueError(
            "TypeScript public entry points changed; update the documentation contract generator: "
            f"declared={sorted(declared_entrypoints)}, known={sorted(ts_entry_files)}"
        )
    ts_entrypoints: dict[str, dict[str, list[str]]] = {}
    for export_path, filename in ts_entry_files.items():
        specifier = (
            ts_manifest["name"] if export_path == "." else f"{ts_manifest['name']}{export_path[1:]}"
        )
        ts_entrypoints[specifier] = {"publicExports": typescript_exports(ts_source / filename)}
    setup_schema_path = root / "packages/sdk-typescript/setup-events.schema.json"
    setup_schema = json.loads(setup_schema_path.read_text())

    py_modules = {
        "hue_sdk": py_source / "__init__.py",
        "hue_sdk.evals": py_source / "evals/__init__.py",
        "hue_sdk.managed": py_source / "managed.py",
    }
    skill = skill_frontmatter(skill_path)
    skill.update({"source": str(skill_path.relative_to(root)), "sha256": sha256(skill_path)})

    return {
        "schemaVersion": 1,
        "repository": "https://github.com/hue-run/hue-sdk",
        "packages": {
            "typescript": {
                "name": ts_manifest["name"],
                "version": ts_manifest["version"],
                "bins": ts_manifest.get("bin", {}),
                "entrypoints": ts_entrypoints,
                "schemas": {
                    f"{ts_manifest['name']}/setup-events.schema.json": {
                        "contractVersion": setup_schema["$defs"]["base"]["properties"][
                            "contractVersion"
                        ]["const"],
                        "id": setup_schema["$id"],
                        "source": str(setup_schema_path.relative_to(root)),
                        "sha256": sha256(setup_schema_path),
                    }
                },
            },
            "python": {
                "name": py_manifest["name"],
                "version": py_manifest["version"],
                "modules": {
                    name: {"publicExports": python_exports(path)}
                    for name, path in py_modules.items()
                },
            },
        },
        "compatibility": compatibility_metadata(compatibility_path, root),
        "skill": skill,
    }


def render_contract(contract: dict[str, Any]) -> str:
    return json.dumps(contract, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def check_output(output: Path, expected: str) -> bool:
    try:
        display = str(output.relative_to(ROOT))
    except ValueError:
        display = str(output)
    if not output.exists():
        print(f"{display} is missing; generate it with {Path(__file__).name}")
        return False
    actual = output.read_text()
    if actual == expected:
        print(f"{display} is current")
        return True
    print(f"{display} is stale; regenerate it with {Path(__file__).name}")
    print(
        "\n".join(
            difflib.unified_diff(
                actual.splitlines(),
                expected.splitlines(),
                fromfile=display,
                tofile="generated contract",
                lineterm="",
            )
        )
    )
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="fail instead of updating a stale contract"
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    output = args.output if args.output.is_absolute() else ROOT / args.output
    expected = render_contract(build_contract())
    if args.check:
        return 0 if check_output(output, expected) else 1
    output.write_text(expected)
    print(f"wrote {output.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
