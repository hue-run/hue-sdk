# Packaging and release verification map

The maintained source for proving changes to how the SDKs are built, installed and released. Read this index, then use the matching feature file.

## Baseline preconditions

- Root and package dependencies installed with frozen lockfiles.
- No `HUE_API_KEY` or registry token in the shell.
- Archives go to `.context/verify-package/`.

## Driving conventions

- Run commands from the repository root unless a step says otherwise.
- Build and verify only. Publishing, dist-tag changes and registry acceptance are owner-run workflow steps.

## Proof and skip reporting

- Proof is the command plus its inventory or pass line for the archive you changed.
- Name the slow checks you left to CI (full verifier, wheel consumers) instead of implying they ran.

## Features

- [npm tarball](./npm-tarball.md): build, inventory, exports and installed consumers of `@hue-run/sdk`.
- [Python wheel](./python-wheel.md): build, inventory and installed use of `hue-run`.
- [Release tooling](./release-tooling.md): `scripts/*.py`, versions, changelog and docs contract.
