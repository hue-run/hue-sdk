# Hue SDK verification map

The maintained source for proving changes to the public SDK surface. Read this index, then use the matching feature file.

## Baseline preconditions

- Dependencies installed and `packages/sdk-typescript/dist` built (see the skill's Launch).
- Loopback stub running, `HUE_BASE_URL` exported, for drives only.
- Synthetic keys only (`synthetic-verify-key`). Never a real Hue or provider key.

## Driving conventions

- Run test commands from the package directory; run drives from the repository root.
- Filter by test name. A whole file is acceptable only when it runs in a few seconds.
- Scratch files go in the per-run `$V` from the skill's Launch (`.context/verify-sdk-*`).

## Proof and skip reporting

- Test proof: the command and its `pass`/`fail` summary.
- Drive proof: the script output and the stub request lines (`cat $V/stub.log`) for the same run, labeled as a loopback-stub drive. The stub is a fake Hue API.
- Name any language you did not cover. Do not report a TypeScript run as proof for Python.

## Features

- [TypeScript tracing](./typescript-tracing.md): `createHue`, spans, tools, capture, redaction, flush results.
- [Python tracing](./python-tracing.md): `Hue`, spans, models, tools, capture, `force_flush`.
- [Evaluations](./evaluations.md): `@hue-run/sdk/evals` and `hue_sdk.evals` clients and runners.
- [hue CLI](./hue-cli.md): `hue eval`, `login`, `mcp`, `listen`, `setup`.
