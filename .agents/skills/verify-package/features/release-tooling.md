# Release tooling

The scripts under `scripts/` back the owner-run `Release SDK` workflow and docs checks: release policy, artifact inspection, prepared-release reuse, registry waits, npm dist-tags, changelog and version mentions, and the generated docs contract.

## Sub-features

- `release-scripts` (`release-policy.py`, `release-artifacts.py`, `verify-prepared-release.py`, `wait-for-registry.py`, `npm-release-tags.py`).
- `doc-versions` keeps version mentions in docs current.
- `docs-contract` keeps `docs-contract.json` in step with the public API.
- `changelog` validates changelog entries.

## How to get to it (user POV)

- Maintainers run the `Release SDK` workflow with `publish=false`, then `publish`. Users see the result as the published version, changelog and docs.

## Driving it with python3

Preconditions:

- Python 3.11+. No network or registry credentials needed.

- **One script's tests** (under 0.5 s). `python3 -m unittest scripts.test_release_artifacts 2>&1 | tail -1`. Expected: `OK`. Test modules: `test_release_policy`, `test_verify_prepared_release`, `test_wait_for_registry`, `test_npm_release_tags`, `test_changelog`, `test_check_doc_versions`, `test_generate_docs_contract`, `test_docs_drift`, `test_skill_gate`.
- **All script tests** (0.6 s). `python3 -m unittest discover -s scripts -p 'test_*.py'`. Expected: `OK`.
- **Docs files** (0.3 s). `python3 scripts/check-doc-versions.py && python3 scripts/generate-docs-contract.py --check`. Expected: `0 stale mention(s)` and `docs-contract.json is current`. After an intended API change run `bun run docs:contract` and commit the result.

## Gotchas

- `scripts/check-docs-drift.py` fetches the hosted docs over the network and runs on a schedule, not per PR. A failure there reflects the live site, not your branch.
- Do not edit `.github/workflows/` or release steps without maintainer authorization (AGENTS.md).
