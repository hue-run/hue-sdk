---
name: verify-package
description: "Verify a change to how the Hue SDKs are built, packed, installed or released: the npm tarball (@hue-run/sdk), the Python wheel and sdist (hue-run), package exports and file inventory, version and docs-contract files, and the release scripts under scripts/. Use before opening a PR that touches package.json, pyproject.toml, build config, packages/*/scripts, scripts/ or release docs. Never publishes."
---

# Verify packaging and release

Users get the SDKs from npm and PyPI, so the user path is: build the archive, inspect what is inside, install it into a fresh consumer and use it. Release publishing is owner-only and runs in GitHub Actions; locally you only build and verify archives, the equivalent of the `publish=false` release run. Never run `npm publish`, `uv publish` or the release workflow.

Run the narrowest check that covers the change. The full verifier takes about 6.5 minutes and CI runs it on every PR across Node 22, 24, 26 and Bun.

## Launch

Nothing to keep running. Install once: `bun install --frozen-lockfile` at the root, plus the package installs in [verify-sdk](../verify-sdk/SKILL.md). Write archives to `.context/verify-package/` (ignored by Git and eslint).

## Doctor

`node -v` (22, 24 or 26), `bun -v` (1.4.2), `uv --version` (uv 0.12.5), `python3 -V` (3.11+ for the release scripts). Unset `HUE_API_KEY` before the full verifier: a key in the shell makes its installed-setup case fail with `configuration_conflict`.

## Drive

Pick the feature in [features/](features/README.md). Measured on a 4-core VM:

| Check | Time |
| --- | --- |
| `npm pack --dry-run --ignore-scripts` (tarball inventory) | 0.4 s |
| `uv build` + `release-artifacts.py inspect python` | 0.9 s |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | 0.6 s |
| `check-doc-versions.py` + `generate-docs-contract.py --check` | 0.3 s |
| One release script test: `python3 -m unittest scripts.test_<name>` | under 0.5 s |
| Full `verify-package.mjs` (tarball, Node and Bun consumers, chatbot) | about 6.5 min, CI |
| `pytest tests/test_wheel.py` (standalone wheel consumers) | about 3 min, CI |

## Evidence

Paste the command and its last lines: the inventory counts (`total files`, `Inspected <archive>: N files`), the `OK`/`current` line, or the verifier's final JSON (`tarball`, `consumer`, `chatbot`). Inventory output alone does not prove an export works; when exports or entry points change, also import them from an installed consumer (see the feature file).

## Cleanup

`rm -rf .context/verify-package` once the evidence is in the PR. The full verifier works in a `/tmp/hue-sdk-package-*` directory it prints; delete it after reading its output.
