# Hue SDK repository

This repository is public and MIT-licensed. Read README.md and the relevant package guide before changing code.

- Keep the TypeScript and Python SDKs usable from a standalone checkout. Do not import Hue application code or connect SDK tests to customer databases.
- Use Node 24, Bun 1.3.9 and uv 0.12.5; preserve frozen lockfiles and the tested compatibility matrix.
- Test changed behavior from an installed tarball/wheel, including exporter acknowledgements and privacy boundaries. Use synthetic HTTP providers and loopback receivers; do not call paid providers to test implementation.
- Preserve public API presence bits, explicit capture policy, flush/shutdown results and existing OpenTelemetry ownership.
- Never print or commit real keys, customer data, internal links or unreleased platform details. Pull request descriptions and commit messages are public. Keep local environments ignored.
- Do not change repository visibility, licensing, package registry configuration, `.github/workflows/` or release steps without explicit maintainer authorization.
- Prefer bounded branches and PRs. Inspect base changes and reuse unchanged-source evidence; do not repeat full suites solely for ancestry changes.
- README branding includes the supplied Hue ASCII art; preserve it.

## Verification (definition of done)

Run from the repository root before opening a pull request. All four must succeed:

```sh
node packages/sdk-typescript/scripts/verify-package.mjs
bun install --frozen-lockfile && bun run lint && bun run format:check
python3 -m unittest discover -s scripts -p 'test_*.py'
(cd packages/sdk-python && uv sync --frozen --all-groups && uv run --frozen --all-groups pytest && uv run --frozen --all-groups ruff check src tests ../../examples/python-agent ../../examples/python-evaluation && uv run --frozen --all-groups ruff format --check src tests ../../examples/python-agent ../../examples/python-evaluation && uv run --frozen --all-groups mypy)
```

CI runs the same checks on Node 24 and on Python 3.10 and 3.14. Documentation-only changes need accurate, runnable snippets and working links. See CONTRIBUTING.md for review expectations, RELEASING.md for releases, VERSIONING.md for the compatibility policy and SECURITY.md for vulnerability reports.
