# Contributing

Work on a short branch from current `main` and open a pull request with the behavior change and relevant verification. Repository access is currently limited to invited contributors.

## Development

Use Node 24, Bun 1.3.9 and uv 0.12.5. Each package owns its dependencies and lockfile; the repository is not a shared runtime workspace.

- TypeScript: run `node packages/sdk-typescript/scripts/verify-package.mjs` from the root. It validates public imports from installed packages with both tested AI SDK patch pairs.
- Python: use the commands in [README.md](README.md), then repeat pytest on Python 3.10 for compatibility changes.
- Examples: keep them independent of Hue application source. Synthetic mode must be explicit; provider errors must not silently fall back to synthetic success.

## Review expectations

Add behavioral regression coverage for changed delivery, privacy, concurrency or retry behavior. Documentation-only changes need accurate, runnable snippets and working links, not a repeated application test suite. Explain any remaining live integration limit.

Never include real credentials, customer prompts or files in fixtures, logs or screenshots. Share security concerns through the private repository's existing maintainers instead of posting secrets.

Public package publication and a future open-source license are separate decisions; do not add a permissive license or remove package privacy flags without authorization.
