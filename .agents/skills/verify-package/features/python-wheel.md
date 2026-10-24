# Python wheel

`hue-run` is built from `packages/sdk-python` into `hue_run-<version>-py3-none-any.whl` and an sdist. Users `pip install hue-run` (optionally `hue-run[evals]`) and `import hue_sdk`.

## Sub-features

- `wheel-inventory` ships exactly the intended modules and metadata.
- `wheel-consumer` installs the same candidate wheel into fresh pip and uv environments on Python 3.10 and 3.14. Pip runs broad behavior; uv runs content-default, metadata-only and isolated schema-worker checks. Both import before frozen test dependencies are added.

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
- `scripts/verify-python-release.py` is the release-time consumer check and needs the selected Python 3.10 or 3.14 available. Its fresh pip and uv consumers run concurrently in separate environments; a failure waits for the other consumer to finish before temporary files are removed.
- CI builds one universal wheel and shares its checksummed bytes across the two certified-runtime jobs. Lowest-dependency jobs retain their own build-tool floor proof and build one wheel per session. `HUE_TEST_WHEEL` supplies that archive to the four nested packaging cases. Without it, the source tests build once per pytest session. Source-only packaging cases and installed behavior run in parallel, and either failure fails the job.

## Media release contract

For Python 0.13.6, compare `pyproject.toml`, `src/hue_sdk/_version.py`, the editable project in `uv.lock`, wheel and sdist metadata, and `docs-contract.json`. Run `python3 scripts/check-doc-versions.py` and `python3 scripts/generate-docs-contract.py --check` from the repository root. Confirm the frozen lock retains every resolved dependency version.

From an installed wheel, send binary media and text over 64 KiB to a loopback blob receiver. Check decoded bytes, the binary part's digest and size, and the text prefix and content-field entry. Exercise `record_file` with upload omitted and enabled, a Unicode name, an upload failure, content capture disabled and setup credentials. Supplied helper data is limited to 25 MiB; whole string attributes retain their separate 1,000,000,000-byte limit. Inspect the same-span `event:hue.file:<sha256>` entry and the unchanged `hue.file` event. Place an `Attachment` in a `span()` input and in a `log_inference` body next to an inline image, and check that each file is reserved once, the span lists `input.value#<pointer>` and the log record lists `body#<pointer>` entries in its own `hue.blobs`, under the span's trace. The shared corpus must remain byte-identical to the TypeScript copy; fixtures must not enter the wheel.
