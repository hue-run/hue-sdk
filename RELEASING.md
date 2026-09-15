# SDK releases

The repository stays private. Public package distribution is a separate decision: PyPI serves both `pip install hue-sdk` and `uv add hue-sdk`; npm serves `npm install @hue/sdk` and other npm-compatible installers.

The SDK packages use the MIT license. Registry account setup and a successful publishing run are still required for public availability. A workflow file or a passing build does not mean a version is publicly available.

## Release contract

1. Merge the reviewed version, changelog, package metadata and lockfile changes into `main`. Approve the actual license text before packaging; the archive gate rejects missing licenses and `UNLICENSED` metadata.
2. Run **Release SDK** (`.github/workflows/release.yml`) from `main`, selecting the language and exact committed stable version. Leave **publish** unchecked to prepare downloadable artifacts without publishing. The workflow always checks out its immutable triggering commit; it cannot publish a feature branch.
3. Preparation builds once, tests installed packages, inspects the distribution inventory, and records `release-manifest.json` plus `SHA256SUMS`. TypeScript runs both supported AI SDK/OTel patch pairs and the Node reference chatbot. Python installs the same wheel using both pip and uv on Python 3.10 and 3.14, exercising tracing, logs, evaluation, privacy, acknowledgements and cloud configuration against synthetic loopback services.
4. After registry setup, select **publish** to prepare, verify and publish. Only the isolated publishing jobs receive `id-token: write`. They download the verified artifacts, check hashes and publish unchanged bytes; they do not check out source or rebuild packages. The npm job disables lifecycle scripts.
5. Public registry acceptance fetches the published archives and verifies their SHA-256 against the tested artifacts. Fresh consumers then install by package name and exact version, without GitHub credentials or local archive overrides, and rerun behavioral checks.
6. Record the workflow run, source commit, versions and checksums in language-specific GitHub releases (for example `typescript-v0.1.2` and `python-v0.1.0`). Update public availability statements only after registry acceptance succeeds.

Publication is not rolled back automatically if acceptance fails. Investigate the published version, correct the issue in a reviewed patch release, and use registry deprecation/yank controls deliberately if needed. Do not retry publication with different bytes under the same version.

## Registry setup

Confirm control of npm's `@hue` scope and PyPI's `hue-sdk` project name. An absent listing does not prove that a name is available. Keep registry credentials out of source, logs and archives.

Configure GitHub environments `npm` and `pypi` to allow `main` only. Use those exact names when registering trusted publishers. The workflow has no registry token secrets or token fallback.

### PyPI

Create a [pending trusted publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/) for:

- Project: `hue-sdk`
- Owner: `hue-run`
- Repository: `hue-sdk`
- Workflow: `release.yml`
- Environment: `pypi`

A pending publisher supports the first real package publication; it does not reserve the project name. The workflow uses PyPA's pinned publishing action with OIDC and [digital attestations](https://docs.pypi.org/attestations/producing-attestations/). No placeholder package is needed.

### npm

npm configures trusted publishers on an existing package. An authorized owner must perform the first public publication of the **real, fully tested archive** through their npm account; [staged publishing cannot create a new package](https://docs.npmjs.com/staged-publishing/).

Download the prepared TypeScript workflow artifact, verify its checksums, and publish the archive without rebuilding it:

```bash
# Run inside the downloaded artifact directory, using the authorized npm account.
sha256sum --check SHA256SUMS
npm publish ./hue-sdk-0.1.2.tgz --access public --ignore-scripts --provenance=false --registry=https://registry.npmjs.org
```

On macOS, use `shasum -a 256 -c SHA256SUMS`. The account may require an interactive login or 2FA; do not put registry tokens into these commands or commit authentication files.

After bootstrap, register the [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) with owner `hue-run`, repository `hue-sdk`, workflow `release.yml`, environment `npm`, and permission to publish directly. Subsequent releases use the isolated OIDC publishing job. It installs the pinned npm 11.15.0 CLI under Node 24. npm provenance is unavailable for private source repositories; keeping this repository private does not prevent public package distribution or OIDC authentication.

Do not rerun the publishing workflow for the version already published manually. Run its acceptance commands below against the downloaded manifest and archive instead.

## Local preparation and acceptance

Use Node 24, Bun 1.3.9 and uv 0.12.5. Run commands from the repository root. `scripts/release-artifacts.py` and `scripts/verify-python-release.py` require Python 3.11+ to orchestrate checks; the latter installs and tests SDK consumers on the selected Python 3.10 or 3.14 runtime.

### TypeScript

```bash
# Retain the exact tarball only after the installed package checks pass.
node packages/sdk-typescript/scripts/verify-package.mjs --artifacts-dir .artifacts/typescript
python3 scripts/release-artifacts.py inspect typescript 0.1.2 .artifacts/typescript

# Recheck a previously built artifact without rebuilding it.
node packages/sdk-typescript/scripts/verify-package.mjs --archive .artifacts/typescript/hue-sdk-0.1.2.tgz

# Only after public publication, using that release commit and artifact manifest:
python3 scripts/release-artifacts.py registry typescript 0.1.2 .artifacts/typescript
node packages/sdk-typescript/scripts/verify-package.mjs --registry-version 0.1.2
```

### Python

```bash
uv sync --project packages/sdk-python --frozen --all-groups --python 3.14
uv run --project packages/sdk-python --frozen --all-groups --python 3.14 python -m build packages/sdk-python --no-isolation --outdir .artifacts/python
uvx --from twine==7.0.0 twine check --strict .artifacts/python/*
python3 scripts/release-artifacts.py inspect python 0.1.0 .artifacts/python
python3 scripts/verify-python-release.py --wheel .artifacts/python/hue_sdk-0.1.0-py3-none-any.whl --python 3.10
python3 scripts/verify-python-release.py --wheel .artifacts/python/hue_sdk-0.1.0-py3-none-any.whl --python 3.14

# Only after public publication:
python3 scripts/release-artifacts.py registry python 0.1.0 .artifacts/python
python3 scripts/verify-python-release.py --registry-version 0.1.0 --python 3.10
python3 scripts/verify-python-release.py --registry-version 0.1.0 --python 3.14
```

Use a new artifact directory for each preparation. The inspection command accepts only the expected package files, then writes the manifest and checksums. Preserve those files as release evidence. Python's standard build creates the wheel from the source distribution; installed checks use that same wheel. The copied behavioral suite excludes its two nested wheel-building cases so it cannot accidentally test a newly rebuilt package.

All integration checks use synthetic services. No paid model API, production Hue key, application database, or Fern checkout is required. Review compatibility and the changelog separately; a passed release test certifies the tested combinations, not every framework or dependency version.
