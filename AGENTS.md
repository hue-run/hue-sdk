# Hue SDK repository

- Read README.md and the relevant package guide before changing code.
- Keep TypeScript/Python SDKs usable from a standalone checkout. Do not import Fern application code or connect SDK tests to customer databases.
- Use Node 24, Bun 1.3.9 and uv 0.12.5; preserve frozen lockfiles and the tested compatibility matrix.
- Test changed behavior from an installed tarball/wheel, including exporter acknowledgements and privacy boundaries. Use synthetic HTTP providers and loopback receivers; do not call paid providers to test implementation.
- Preserve public API presence bits, explicit capture policy, flush/shutdown results and existing OpenTelemetry ownership.
- Never print or commit real keys. Keep local environments ignored.
- Keep this repository private. Public visibility, npm/PyPI publication and open-source licensing require explicit user authorization.
- Prefer bounded branches and PRs. Inspect base changes and reuse unchanged-source evidence; do not repeat full suites solely for ancestry changes.
- README branding includes the supplied Hue ASCII art; preserve it.

