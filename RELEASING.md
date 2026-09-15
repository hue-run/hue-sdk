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

The intended registry commands are `pip install hue-sdk` and `npm install @hue/sdk`. Both package names already match their metadata; no package rename is needed. These commands become available only after the packages are published.

Before publication:

1. Confirm the registry owner and publishing access for PyPI's `hue-sdk` and npm's `@hue` scope. An absent public package listing does not prove that its name or scope is available.
2. Approve package distribution terms and finalize release versions. Python currently declares `0.1.0.dev0`; choose the intended public release version and update its lockfile and examples together. Both packages currently declare `UNLICENSED`.
3. Prepare the reviewed public-release metadata. The TypeScript package currently has `private: true`, which blocks npm publication; public scoped publication also requires `--access public` or equivalent `publishConfig`.
4. Add a release workflow bound to the reviewed repository, workflow and release environment, with registry trusted publishing. The existing CI only tests and builds archives; it does not publish them. [PyPI supports a pending publisher for a first release](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/). [npm documents its package publisher setup and required OIDC permission](https://docs.npmjs.com/trusted-publishers/).
5. Publish the verified artifacts, then verify the exact registry versions and clean installs from fresh consumers. Update availability statements in the root and package READMEs only after those checks succeed.

The GitHub repository can remain private when distributing public packages. Repository visibility and licensing remain separate decisions; npm's [provenance attestation is unavailable for private source repositories](https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation), even with trusted publishing. No registry publication or account configuration is enabled by these instructions.
