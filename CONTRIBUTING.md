# Contributing

Fork the repository (or branch directly if you have write access), work on a short branch from current `main`, and open a pull request with the behavior change and its verification. Search existing issues before filing a new one.

## License of contributions

This repository is licensed under the [MIT License](LICENSE). By submitting a pull request you agree that your contribution is licensed under the same MIT License (inbound = outbound). No contributor license agreement is required. If your employer owns your work, confirm that you may contribute it under MIT.

## Development

Use Node 24, Bun 1.4.2 and uv 0.12.5 (`.tool-versions` and `.bun-version` record them). Each package owns its dependencies and lockfile; the repository is not a shared runtime workspace. `bunfig.toml` refuses package versions younger than three days on non-frozen installs; pass `--minimum-release-age 0` for a deliberate one-off.

- TypeScript: run `node packages/sdk-typescript/scripts/verify-package.mjs` from the root. It validates public imports from installed packages with both tested AI SDK patch pairs.
- Python: use the commands in [README.md](README.md), then repeat pytest on Python 3.10 for compatibility changes.
- Release tooling: run `python3 -m unittest discover -s scripts -p 'test_*.py'`.
- Lint and format: `bun install --frozen-lockfile` once at the repository root, then `bun run lint` (type-checked eslint over the TypeScript SDK) and `bun run format:check` (prettier). Python runs `ruff check`, `ruff format --check` and `mypy` inside `packages/sdk-python`. `pre-commit install` wires the same checks into Git hooks.
- Examples: keep them independent of Hue application source. Synthetic mode must be explicit; provider errors must not silently fall back to synthetic success.

## Review expectations

Add behavioral regression coverage for changed delivery, privacy, concurrency or retry behavior. Documentation-only changes need accurate, runnable snippets and working links, not a repeated application test suite. Explain any remaining live integration limit.

Never include real credentials, customer prompts or files in fixtures, logs or screenshots. Pull request descriptions and commit messages are public; do not link internal systems or paste unreleased platform details. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md) rather than in a public issue.

Do not change the license, package visibility, registry publishing configuration or release workflows without explicit maintainer authorization. See [VERSIONING.md](VERSIONING.md) for what a patch or minor release may change.
