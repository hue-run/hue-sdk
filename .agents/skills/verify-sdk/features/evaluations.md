# Evaluations

Code runs eval sets against a local target with `@hue-run/sdk/evals` (TypeScript) or `hue_sdk.evals` (Python): clients for eval sets, evaluators and runs, local scorers, checkpoints and resumable uploads.

## Sub-features

- `eval-client` creates and reads eval sets, evaluators and runs through `/api/v1` paths.
- `eval-runner` runs targets, scores locally, checkpoints and resumes.
- `eval-direct` runs direct cases and files (TypeScript).

## How to get to it (user POV)

- `import { ... } from "@hue-run/sdk/evals"` (packages/sdk-typescript/EVALUATIONS.md).
- `from hue_sdk.evals import EvaluationClient, run_experiment` (packages/sdk-python/EVALUATIONS.md).

## Driving it with the package tests

Preconditions:

- Dependencies installed (Launch). The tests start their own loopback evaluation receivers; the stub is not used.

- **TypeScript.** `cd packages/sdk-typescript && bun test tests/evals.test.ts -t "<behavior>"`. The whole file is 42 tests in about 17 s. Related files: `attempt`, `checkpoint-lock`, `files`, `verdicts`, `scorer-publication`, `local-worker`.
- **Python.** `cd packages/sdk-python && uv run --frozen --all-groups pytest tests/test_evaluations.py -q -k product_registry`. Expected: selected tests pass in about 1 s.

## Gotchas

- The stub does not implement evaluation routes; a script that calls `EvaluationClient` against it fails. Use the test receivers.
- A live run against a real Hue project needs a maintainer's project key and is not part of PR verification.
