# SDK releases

Repository access and package distribution are independent. This repository stays private; npm and PyPI publication are not enabled. Existing private release assets can be installed with the [GitHub download commands](README.md#from-a-private-github-release--available-now).

## Prepare private pilot archives

1. Update the relevant package version and lockfile in a reviewed PR.
2. Run the installed TypeScript verifier or Python minimum/current runtime checks, as appropriate. Confirm the resulting archive contains only the package's documented files.
3. Build the archives below from the checked commit and record their SHA-256 checksums.
4. Attach them to a private GitHub prerelease pinned to that commit. Use language-specific tags such as `typescript-v0.1.1` and `python-v0.1.0.dev0` when versions differ.
5. Install the attached archive from a fresh consumer directory and update the matching documentation and demo pin.

```bash
mkdir -p .artifacts
cd packages/sdk-typescript
bun install --frozen-lockfile
bun run build
bun pm pack --destination ../../.artifacts
cd ../sdk-python
uv sync --frozen --all-groups --python 3.14
uv run --frozen --all-groups --python 3.14 python -m build --no-isolation --outdir ../../.artifacts
```

The TypeScript verifier prints the exact tarball it tested; use that artifact when available. Do not substitute a new archive while retaining an old checksum.

## Public release

Publish the Python distribution to **PyPI** and the TypeScript distribution to **npm**. PyPI serves both `pip install hue-sdk` and `uv add hue-sdk`; npm serves npm, Bun, pnpm and Yarn. They do not need separate releases for each installer. Both package names already match their metadata. These commands become available only after the packages are published.

Before publication:

1. Confirm the registry owner and publishing access for PyPI's `hue-sdk` and npm's `@hue` scope. An absent public package listing does not prove that its name or scope is available.
2. Approve package distribution terms and finalize release versions. Python currently declares `0.1.0.dev0`; choose the intended public release version and update its lockfile and examples together. Both packages currently declare `UNLICENSED`.
3. Prepare the reviewed public-release metadata. The TypeScript package currently has `private: true`, which blocks npm publication; public scoped publication also requires `--access public` or equivalent `publishConfig`.
4. Review [compatibility](COMPATIBILITY.md), unresolved release issues and the [changelog](CHANGELOG.md). Reproduce the supported integration paths from installed archives. An unsupported dependency combination must not be advertised as a drop-in integration.
5. Add a release workflow bound to the reviewed repository, workflow and release environment. The existing CI only tests and builds archives; it does not publish them. Use the first-release setup below instead of assuming that both registries bootstrap identically.
6. Build once from the reviewed commit, record SHA-256 checksums and carry those same tested artifacts into the release job. Validate the wheel and source distribution metadata with `twine check`; inspect npm's pack inventory and compiled exports. Record the commit, versions, artifacts and checksums in release notes.
7. Publish the verified artifacts, then perform the registry acceptance checks below. Update availability statements in Mintlify and the root/package READMEs only after those checks succeed.

### First-release setup

- **PyPI:** configure a [pending trusted publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/) for the intended project, GitHub repository, workflow and environment. It can create the project on first publication; it does not reserve the name. Use a supported publishing action with [digital attestations](https://docs.pypi.org/attestations/producing-attestations/).
- **npm:** confirm control of `@hue`, then arrange an authorized initial public publish through the organization's registry account. Trusted publishers are configured on an existing package. [Staged publishing cannot create a new package](https://docs.npmjs.com/staged-publishing/). After bootstrap, configure the package's [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for the exact repository, workflow and environment; choose staged or explicitly permitted direct publication. Trusted publishing requires npm 11.5.1 or later; staged publishing requires npm 11.15.0 or later. Use a supported Node runtime and the documented OIDC permissions.

Do not commit registry tokens or put them in package archives. Account ownership, distribution terms and release authorization must be settled before enabling a publishing job.

### Registry acceptance

Install the exact new version in fresh consumer directories, using registry resolution rather than a local archive or GitHub URL:

1. npm: install the package, typecheck and run imports from core and `/evals`, then exercise the documented AI integration with each supported peer pair. Include an existing-provider application so a new release does not disrupt another exporter.
2. Python: install through both pip and uv, verify `hue_sdk` and `hue_sdk.evals`, and run a synthetic first trace and local evaluation on the minimum/current tested Python versions.
3. Check the package pages, rendered README links, source/release links, declared license and version. Verify the registry archive matches the tested artifact, accounting for registry-provided metadata separately.
4. Confirm that the docs' install commands and version examples resolve without private GitHub access. Keep the first-trace and local-evaluation smoke tests in CI; paid model calls and production keys are not prerequisites for package verification.

The GitHub repository can remain private when distributing public packages. Repository visibility and licensing remain separate decisions; npm's [provenance attestation is unavailable for private source repositories](https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation), even with trusted publishing. No registry publication or account configuration is enabled by these instructions.
