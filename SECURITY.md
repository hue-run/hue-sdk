# Security policy

## Supported versions

Security fixes are released for the latest minor version of each package: `@hue-run/sdk` 0.1.x on npm and `hue-run` 0.1.x on PyPI. Earlier versions do not receive fixes; upgrade to the current release.

## Reporting a vulnerability

Do not open a public issue for a security problem.

- Preferred: use GitHub private vulnerability reporting on this repository ("Report a vulnerability" under the Security tab).
- Alternatively, email team@hue.run with a description, the affected package versions and reproduction steps.

You will receive an acknowledgement within three business days. We aim to ship a fix within 90 days of a confirmed report and will coordinate disclosure timing with you; please allow that window before publishing details.

## Scope

This policy covers the SDK source in this repository, the published packages, the examples, the coding-agent skill and the release workflows. Report issues in the hosted Hue platform (app.hue.run) to the same address.

Security-relevant SDK behavior is documented in [RELIABILITY.md](RELIABILITY.md) (failure isolation and resource bounds), [packages/sdk-python/SAFETY.md](packages/sdk-python/SAFETY.md) (Python content and callback limits) and the privacy sections of each package README (explicit content capture and redaction). Releases are published from CI through OIDC trusted publishing; see [RELEASING.md](RELEASING.md) for how to verify a downloaded artifact against the recorded checksums.
