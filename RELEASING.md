# SDK releases

Repository access and package distribution are independent. This repository stays private; npm and PyPI publication are not enabled.

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

Before public distribution, explicitly approve repository visibility, license, package names and registry ownership. Configure scoped trusted publishing, then verify clean registry installs and the documentation's exact commands. No registry credentials or public-publish workflow are present in this pilot repository.

