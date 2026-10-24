"""Validate own-repository GitHub blob/tree links against Git, without HTTP."""

import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def git(root, *args):
    result = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, check=False
    )
    return result.stdout.strip() if result.returncode == 0 else None


def target_type(url, root=ROOT):
    parsed = urlsplit(url)
    parts = unquote(parsed.path).strip("/").split("/")
    if parsed.hostname != "github.com" or parts[:2] != ["hue-run", "hue-sdk"]:
        return None
    if len(parts) < 3 or parts[2] not in {"blob", "tree"}:
        return None
    kind, tail = parts[2], parts[3:]
    for split in range(len(tail), 0, -1):
        ref, path = "/".join(tail[:split]), "/".join(tail[split:])
        if any(part in {".", ".."} for part in tail[split:]):
            break
        if ref == "main":
            commit = git(root, "rev-parse", "--verify", "HEAD^{commit}")
        elif re.fullmatch(r"[0-9a-f]{7,40}", ref):
            commit = git(root, "rev-parse", "--verify", f"{ref}^{{commit}}")
        else:
            commit = next(
                (
                    found
                    for prefix in ("refs/heads/", "refs/remotes/origin/", "refs/tags/")
                    if (
                        found := git(
                            root, "rev-parse", "--verify", f"{prefix}{ref}^{{commit}}"
                        )
                    )
                ),
                None,
            )
        if commit:
            actual = git(root, "cat-file", "-t", f"{commit}:{path}")
            expected = "blob" if kind == "blob" else "tree"
            if actual != expected:
                raise ValueError(
                    f"{url}: expected {expected}, found {actual or 'no target'}"
                )
            return actual
    raise ValueError(f"{url}: no matching Git ref and target")


def main():
    checked, problems = 0, []
    for url in set(sys.stdin.read().splitlines()):
        try:
            checked += target_type(url) is not None
        except ValueError as error:
            problems.append(str(error))
    for problem in sorted(problems):
        print(problem)
    print(f"Own GitHub links: {checked} Git targets checked, {len(problems)} errors")
    return bool(problems)


if __name__ == "__main__":
    sys.exit(main())
