## Problem

<!-- What does not work or is missing today, and for whom? -->

## Changes

<!-- What changed and what a reviewer should look at first. Descriptions are public: no keys, customer data, internal links or unreleased platform details. -->

## Verification

<!-- Tick what you ran; paste nothing sensitive. -->

- [ ] `node packages/sdk-typescript/scripts/verify-package.mjs`
- [ ] `python3 -m unittest discover -s scripts -p 'test_*.py'`
- [ ] `cd packages/sdk-python && uv run --frozen --all-groups pytest` (and Python 3.10 for compatibility changes)
- [ ] Behavioral regression added for any change to delivery, privacy, concurrency or retry behavior
- [ ] Documentation snippets are runnable and links resolve
- [ ] `CHANGELOG.md` updated when user-visible behavior changed; see `VERSIONING.md` for what a patch may change
