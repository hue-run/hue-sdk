# Python wheel

`hue-run` is built from `packages/sdk-python` into `hue_run-<version>-py3-none-any.whl` and an sdist. Users `pip install hue-run` (optionally `hue-run[evals]`) and `import hue_sdk`.

## Sub-features

- `wheel-inventory` ships exactly the intended modules and metadata.
- `wheel-consumer` installs into a fresh environment on Python 3.10 and 3.14 and exports a trace.

## How to get to it (user POV)

- `pip install hue-run`, then `from hue_sdk import Hue`.

## Driving it with uv and release-artifacts.py

Preconditions:

- uv 0.12.5; Python 3.11+ for `scripts/release-artifacts.py`.

- **Build and inspect** (0.9 s):

  ```sh
  VER=$(python3 -c 'import tomllib;print(tomllib.load(open("packages/sdk-python/pyproject.toml","rb"))["project"]["version"])')
  rm -rf "$V"/python
  (cd packages/sdk-python && uv build --out-dir "$V"/python)
  rm "$V"/python/.gitignore
  python3 scripts/release-artifacts.py inspect python "$VER" "$V"/python
  ```

  Expected: `Inspected hue_run-<VER>-py3-none-any.whl: 33 files` and `Inspected hue_run-<VER>.tar.gz: 38 files` (counts change only when you add or remove files).
- **Installed consumer.** The python-agent drive in [verify-examples](../../verify-examples/features/python-agent.md) installs this wheel into a fresh venv and exports to the loopback stub (a fake Hue API) in a few seconds.
- **Standalone wheel acceptance** (about 3 min, CI): `cd packages/sdk-python && uv run --frozen --all-groups pytest tests/test_wheel.py -q`.

## Gotchas

- `uv build --out-dir` writes a `.gitignore` into the directory; `release-artifacts.py inspect` rejects it as unexpected inventory, so delete it first.
- `scripts/verify-python-release.py` is the release-time version of the consumer check and needs both Python 3.10 and 3.14 available.
