# Evaluations

Code runs eval sets against a local target with `@hue-run/sdk/evals` (TypeScript) or `hue_sdk.evals` (Python): clients for eval sets, evaluators and runs, local scorers, checkpoints and resumable uploads.

## Sub-features

- `eval-client` creates and reads eval sets, evaluators and runs through `/api/v1` paths.
- `eval-runner` runs targets, scores locally, checkpoints and resumes.
- `eval-direct` runs direct cases and files (TypeScript).
- `eval-media` reads recorded media back (`client.media.fetch`, `client.media.resolve`), rehydrates case inputs from case files (`rehydrateMedia`, `rehydrate_media`) and pins files on case writes (`CaseWrite.files`, `add_case(files=...)`).
- `eval-files-py` hands pinned input files to Python targets and local scorers (`TargetContext.files`, `ScoreContext["files"]`).

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

## Generated media files

Both SDKs accept the same 22 generated-file content types: PDF, DOCX, PPTX, XLSX, `application/json`, `text/plain`, `text/csv`, `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif`, `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`, `audio/mp4`, `audio/flac`, `audio/opus`, `audio/aac`, `video/mp4` and `video/webm`. TypeScript adds GIF and six audio types; Python now restricts managed outputs to this list. Python input files still accept arbitrary valid MIME types. Verify rejection of unsupported outputs such as `audio/pcm`, byte identity, content types, generated-file reservation and completion with a synthetic receiver. For `.mp4` and `.webm`, verify that the declared MIME type distinguishes audio from video.

The file lifecycle checks are:

- **TypeScript.** From `packages/sdk-typescript`, run `bun test tests/files.test.ts -t "downloads pinned inputs, uploads generated files and grades them locally"`.
- **Python.** From `packages/sdk-python`, run `uv run --frozen --all-groups pytest tests/test_managed.py -q -k claim_upload_checkpoint_flush_and_duplicate`.

## Reading media back and case files

The tests run synthetic loopback Hue and storage routes; the storage route asserts that the project key never reaches it.

- **Media read-back.** TypeScript: from `packages/sdk-typescript`, `bun test tests/media.test.ts` (12 tests, about 2 s: digest verification, `digest_mismatch`, `missing` and `not_found`, one `Retry-After` retry, `forbidden`, timeout, `too_large`, snapshots, `resolve` over messages with a failure, `as: "bytes"`, `rehydrateMedia`). Python: from `packages/sdk-python`, `uv run --frozen --all-groups pytest tests/test_media.py -q -k "fetch or resolve or rehydrate or forbidden or invalid"`.
- **Case write files.** TypeScript: `bun test tests/case-files.test.ts`. Python: `uv run --frozen --all-groups pytest tests/test_media.py -q -k add_case`. Expected: uploads reserve the declared identity, stage the exact bytes, settle `ready`, the case body carries `files: [{artifactId, role}]`, a repeated write uploads nothing, and files outside the policy are refused with no request.
- **Python runner files.** `uv run --frozen --all-groups pytest tests/test_evaluations.py -q -k pinned`. Expected: the target sees only agent-visible files (0600 in a 0700 directory), the local scorer sees every pinned file in `run_experiment` and in `rescore`, and a mismatched download raises `CaseFileError` before any execution starts.
