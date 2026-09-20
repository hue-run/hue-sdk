# SDK releases

The repository is public. Package distribution: PyPI serves both `pip install hue-run` and `uv add hue-run`; npm serves `npm install @hue-run/sdk` and other npm-compatible installers.

The SDK packages use the MIT license. A workflow file or a passing build does not mean a version is publicly available; only a completed publishing run does.

## Release contract

1. Merge the reviewed version, changelog, package metadata and lockfile changes into `main`. For TypeScript, run `bun run build` in `packages/sdk-typescript` after changing `version` so the generated `src/version.ts` is committed alongside it (CI fails when they disagree). For Python, change `__version__` in `packages/sdk-python/src/hue_sdk/_version.py` together with `version` in `pyproject.toml`; the test suite fails when they disagree. The changelog must contain a `### [X.Y.Z]` entry under the package's section; the workflow refuses to prepare a version without one. Approve the actual license text before packaging; the archive gate rejects missing licenses and `UNLICENSED` metadata.
2. Run **Release SDK** (`.github/workflows/release.yml`) from `main`, selecting the language and exact committed stable version. Leave **publish** unchecked to prepare downloadable artifacts without publishing. The workflow always checks out its immutable triggering commit; it cannot publish a feature branch.
3. Preparation builds once, tests installed packages, inspects the distribution inventory, and records `release-manifest.json` plus `SHA256SUMS`. TypeScript runs both supported AI SDK/OTel patch pairs and the Node reference chatbot. Python installs the same wheel using both pip and uv on Python 3.10 and 3.14, exercising tracing, logs, evaluation, privacy, acknowledgements and cloud configuration against synthetic loopback services.
4. After registry setup, select **publish** to prepare, verify and publish. Only the isolated publishing jobs receive `id-token: write`. They download the verified artifacts, check hashes and publish unchanged bytes; they do not check out source or rebuild packages. The npm job disables lifecycle scripts. Ordinary TypeScript releases retain the default `latest` tag; an activation-gated release selects the closed `hue-onboarding-candidate` tag instead. TypeScript `0.4.0` additionally requires `prepared_run_id` identifying its accepted, successful `publish=false` run on the same immutable main commit; publication downloads and rechecks that archive without rebuilding it.
5. Public registry acceptance fetches the published archives and verifies their SHA-256 against the tested artifacts. For npm it also requires provenance attestations on the published version. Fresh consumers then install by package name and exact version, without GitHub credentials or local archive overrides, and rerun behavioral checks.
6. After registry acceptance, the workflow creates or updates the language-specific GitHub release (for example `typescript-v0.1.2` and `python-v0.1.0`) from the changelog entry, attaching the archive, `release-manifest.json` and `SHA256SUMS`. Update public availability statements only after registry acceptance succeeds.

Publication is not rolled back automatically if acceptance fails. Investigate the published version, correct the issue in a reviewed patch release, and use registry deprecation/yank controls deliberately if needed. Do not retry publication with different bytes under the same version.

## Activation-gated npm release

When a TypeScript release must pass hosted acceptance before becoming npm's default, publish the
exact archive once under the repository's fixed non-default tag:

```sh
: "${PREPARED_RUN_ID:?Set the accepted publish=false Release SDK run ID}"
gh workflow run release.yml --ref main \
  -f language=typescript -f version=0.4.0 -f publish=true \
  -f npm_dist_tag=hue-onboarding-candidate -f prepared_run_id="$PREPARED_RUN_ID"
```

The workflow verifies registry bytes, provenance, installed behavior and that the candidate tag
resolves to the requested version, then creates a GitHub prerelease identified as an activation
candidate. For `0.4.0`, workflow validation refuses `latest` even though unrelated TypeScript
releases retain the backward-compatible default. Run hosted acceptance against that immutable
registry version. Do not use `@latest` for this gate.

[npm trusted-publisher OIDC](https://docs.npmjs.com/trusted-publishers/) authenticates `npm publish`,
but does not grant `npm dist-tag add`. Promotion requires an npm maintainer account with package
write access and its own login/second-factor authorization. Run `npm login --auth-type=web
--registry=https://registry.npmjs.org` privately in the owner's local terminal if needed; never
paste a credential into a command, chat, CI log or evidence file. No registry token fallback is
added to GitHub. The POSIX helper runs on Linux/macOS with Python 3.11+.

The release coordinator must serialize all npm tag mutations across maintainers, machines and
release workflows until post-mutation verification finishes. The helper additionally takes a
per-user, package-wide operating-system lock on the local machine. npm dist-tags provide no
compare-and-swap operation, so a local lock and repeated reads cannot protect against another
maintainer mutating the tag from elsewhere. Do not run this helper without that coordinated
exclusive release window.

Download the successful release artifact without repacking it, retain the previous accepted
archive and record the current `latest`. Run the guarded helper without `--apply` first:

```sh
python3 scripts/npm-release-tags.py promote \
  --version 0.4.0 --expected-latest 0.3.2 \
  --artifacts .artifacts/typescript-0.4.0 \
  --acceptance-evidence .artifacts/hosted-production-acceptance.json

# Only after hosted acceptance and production activation are approved:
python3 scripts/npm-release-tags.py promote \
  --version 0.4.0 --expected-latest 0.3.2 \
  --artifacts .artifacts/typescript-0.4.0 \
  --acceptance-evidence .artifacts/hosted-production-acceptance.json --apply
```

The evidence file is the sanitized Fern hosted-production handoff with exactly these fields:

- `format: 1`, `package: {name, version, sha256, integrity}`, `sdkCommit`, and `fernCommit`.
- `releaseRunUrl` under `https://github.com/hue-run/hue-sdk/actions/runs/` and
  `hostedAcceptanceRunUrl` under `https://github.com/hue-run/fern/actions/runs/`.
- `hostedEvidenceSha256`, `servingArtifactSha256`, `servingDatabaseIdentity`,
  `servingDatabaseIdentityTuple`, `previousLatest`, and `productionAccepted: true`.

`servingArtifactSha256` identifies the actual deployed bundle from authenticated Fern Delivery
evidence; a source commit is insufficient. The database tuple has exactly
`{provider: "supabase", environment: "production", projectRef, database: "postgres", migrationDigest}`.
`projectRef` is 20 lowercase letters; `migrationDigest` is 64 lowercase hexadecimal characters.
The database identity is `sha256:` followed by the SHA-256 of UTF-8 `JSON.stringify` of that tuple
in the displayed field order, without whitespace. Fern supplies the tuple from its authenticated
Delivery/schema ledger. The helper reconstructs and verifies this hash. It accepts no cookie,
claim capability, key, arbitrary URL, connection string or email-verification URL in the handoff.

The coordinator must obtain that handoff from the accepted Fern Actions artifact, verify the
successful run and its reviewed commit/serving deployment, and verify the handoff artifact hash.
A hand-written JSON file or a `productionAccepted` boolean is not hosted acceptance. The local
helper validates and binds the supplied identities; it does not authenticate a GitHub Actions
result, attest Fern's running database, or independently verify a Sigstore signature. Its provenance
check requires the canonical immutable npm attestation URL and its preservation across promotion.
The reviewed registry-acceptance gate must independently authenticate the provenance attestation
and bind the package digest to the expected SDK repository, commit and release workflow.

`--apply` checks `npm whoami`, then repeats the exact archive SHA-256/SHA-512, registry bytes,
candidate/provenance metadata, accepted handoff and expected previous `latest` checks immediately
before mutation. [npm may require a second factor for dist-tag writes](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/).
When an OTP is required, append `--prompt-otp` in the owner's interactive terminal: input is hidden,
passed only in the child process environment, and never added to command arguments or logs. There
is no automatic authentication or mutation retry. The helper promotes the existing version with
`npm dist-tag add`, then rechecks exact registry bytes, integrity/provenance metadata and `latest`.
It never publishes or packs. A timeout or response loss requires inspection of registry state
before retrying; a post-mutation failure does not automatically reverse a tag.

Immediately run the clean-repository literal `@latest` Agent/default Terminal acceptance afterward
and mark the GitHub candidate release final only with the same reviewed handoff. Failure keeps the
public landing and working-command claim held.

If activation must roll back, disable provisioning first under Fern's rollback procedure, then
point `latest` back to the previously recorded immutable accepted
version. Dry-run first, then apply through the same authenticated maintainer session:

```sh
python3 scripts/npm-release-tags.py rollback \
  --from-version 0.4.0 --to-version 0.3.2 \
  --artifacts .artifacts/typescript-0.3.2
python3 scripts/npm-release-tags.py rollback \
  --from-version 0.4.0 --to-version 0.3.2 \
  --artifacts .artifacts/typescript-0.3.2 --apply
```

Rollback uses the same coordinated exclusive release window and local lock. It re-verifies the
recorded previous archive against its immutable registry bytes, integrity and provenance before
and after authentication, checks expected current `latest` immediately before the write, and checks
the restored bytes/tag afterward. Append `--prompt-otp` if required. It changes only the default tag.
It cannot remove clients already pinned to 0.4.0; publish a
reviewed patch and deprecate the affected version with an explicit message if the package itself is
unsafe. Never republish different bytes under an existing version.

## Registry setup

Confirm control of npm's `@hue-run` scope and PyPI's `hue-run` project name. An absent listing does not prove that a name is available. Keep registry credentials out of source, logs and archives.

Configure GitHub environments `npm` and `pypi` to allow `main` only. Use those exact names when registering trusted publishers. The workflow has no registry token secrets or token fallback.

### PyPI

Create a [pending trusted publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/) for:

- Project: `hue-run`
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
npm publish ./hue-run-sdk-0.1.2.tgz --access public --ignore-scripts --registry=https://registry.npmjs.org
```

On macOS, use `shasum -a 256 -c SHA256SUMS`. The account may require an interactive login or 2FA; do not put registry tokens into these commands or commit authentication files.

After bootstrap, register the [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) with owner `hue-run`, repository `hue-sdk`, workflow `release.yml`, environment `npm`, and permission to publish directly. Subsequent releases use the isolated OIDC publishing job. It installs the pinned npm 11.15.0 CLI under Node 24. npm generates provenance attestations for trusted-publisher releases only while the source repository is public; the publishing job refuses to run from a private repository, and the acceptance job verifies that the published version carries attestations. npm versions up to 0.1.5 were published while the repository was private and carry npm registry signatures but no provenance attestations; 0.2.0 and later carry provenance. A manual bootstrap publish from a workstation carries no provenance either.

Do not rerun the publishing workflow for the version already published manually. Run its acceptance commands below against the downloaded manifest and archive instead.

## Local preparation and acceptance

Use Node 24, Bun 1.4.2 and uv 0.12.5. Run commands from the repository root. `scripts/release-artifacts.py` and `scripts/verify-python-release.py` require Python 3.11+ to orchestrate checks; the latter installs and tests SDK consumers on the selected Python 3.10 or 3.14 runtime.

### TypeScript

```bash
# Retain the exact tarball only after the installed package checks pass.
node packages/sdk-typescript/scripts/verify-package.mjs --artifacts-dir .artifacts/typescript
python3 scripts/release-artifacts.py inspect typescript 0.1.2 .artifacts/typescript

# Recheck a previously built artifact without rebuilding it.
node packages/sdk-typescript/scripts/verify-package.mjs --archive .artifacts/typescript/hue-run-sdk-0.1.2.tgz

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
python3 scripts/verify-python-release.py --wheel .artifacts/python/hue_run-0.1.0-py3-none-any.whl --python 3.10
python3 scripts/verify-python-release.py --wheel .artifacts/python/hue_run-0.1.0-py3-none-any.whl --python 3.14

# Only after public publication:
python3 scripts/release-artifacts.py registry python 0.1.0 .artifacts/python
python3 scripts/verify-python-release.py --registry-version 0.1.0 --python 3.10
python3 scripts/verify-python-release.py --registry-version 0.1.0 --python 3.14
```

Use a new artifact directory for each preparation. The inspection command accepts only the expected package files, then writes the manifest and checksums. Preserve those files as release evidence. Python's standard build creates the wheel from the source distribution; installed checks use that same wheel. The copied behavioral suite excludes its two nested wheel-building cases so it cannot accidentally test a newly rebuilt package.

All integration checks use synthetic services. No paid model API or production Hue key is required. Review compatibility and the changelog separately; a passed release test certifies the tested combinations, not every framework or dependency version.

## Registry aliases

`packages/aliases/npm-hue-run` and `packages/aliases/pypi-hue-sdk` are thin alias packages that have
not been published yet: `hue-run` on npm will re-export `@hue-run/sdk`, and `hue-sdk` on PyPI will
depend on `hue-run`. Once published, they will make the sibling name on each registry resolve to the
real SDK instead of an unrelated or squatted package (the Python import module is `hue_sdk`). Until
then, `npm install hue-run` and `pip install hue-sdk` do not install Hue's SDK; use `@hue-run/sdk` and
`hue-run`. The aliases are not part of the verified release workflow above.

For the first publication, and again whenever a package releases afterwards, bump the alias to the
same version and its pinned dependency, then publish it by hand with the authorized account (npm
requires a manual first publication before a trusted publisher can be registered):

```bash
(cd packages/aliases/npm-hue-run && npm publish --access public --ignore-scripts)
(cd packages/aliases/pypi-hue-sdk && uvx --from build pyproject-build . && uvx --from twine==7.0.0 twine upload dist/*)
```

Register trusted publishers for both aliases once they exist so later bumps can move into
`release.yml`.
