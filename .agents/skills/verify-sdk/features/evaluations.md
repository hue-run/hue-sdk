# Evaluations

Code runs eval sets against a local target with `@hue-run/sdk/evals` (TypeScript) or `hue_sdk.evals` (Python): clients for eval sets, evaluators and runs, local scorers, checkpoints and resumable uploads.

## Sub-features

- `eval-client` creates and reads eval sets, evaluators and runs through `/api/v1` paths.
- `eval-runner` runs targets, scores locally, checkpoints and resumes.
- `eval-upload-handoff` calls optional replayable `onUploaded` hooks before simulation attempt completion or worker queue acknowledgment. A failed handoff preserves uploaded outputs for recovery.
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
- **Upload handoff.** `cd packages/sdk-typescript && bun test tests/cli-eval-direct.test.ts -t "hosted judge.*handoff"`. Expected: a failed initial checkpoint write, a failed attempt marker and an interrupted worker acknowledgment resume the original uploaded outputs without invoking the agent again. Uses synthetic loopback receivers.
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

- **Media read-back.** TypeScript: from `packages/sdk-typescript`, `bun test tests/media.test.ts` (24 tests, about 5 s: digest verification, `digest_mismatch`, `missing` and `not_found`, one `Retry-After` retry, one retry of a grant whose connection breaks mid-answer and none of one cut past 64 KiB, a redirect failed with its status and never retried, a plain HTTP link refused unless its loopback host is written `localhost`, `127.0.0.1` or `[::1]`, `forbidden`, timeout, a download that ends when bytes stop but not while they keep arriving, `too_large`, snapshots, a snapshot's untyped parts typed from `blobs` (the record's `hue.blobs`, in every form Hue reads), entries with an out-of-range size ignored, text kept as its first 16 KiB never written and listed as `prefix_only` for every entry naming its field, `resolve` over messages with a failure, `as: "bytes"`, `rehydrateMedia`, an Anthropic source with a null type, an own `__proto__` key kept, and blob content written back as base64 for every media type, so Hue reads it as the same bytes). Python: from `packages/sdk-python`, `uv run --frozen --all-groups pytest tests/test_media.py -q` (62 tests, about 30 s, the same behaviors plus the case write files below).
- **Case write files.** TypeScript: `bun test tests/case-files.test.ts`. Python: `uv run --frozen --all-groups pytest tests/test_media.py -q -k add_case`. Expected: uploads reserve the declared identity, stage the exact bytes, settle `ready`, the case body carries `files: [{artifactId, role}]`, a repeated write uploads nothing, a corrected content type reserves a new artifact, the version ID's case does not change the artifact, an artifact a reference names and a file uploads as is pinned once, files outside the policy (a name counted in UTF-16 code units, a name or type beside an `artifactId`, a `path` that cannot be read) or a case Hue would refuse (its revision, key, values or size as sent) are refused with no request, a `path` is hashed a slice at a time and read again whole only to be uploaded, one file at a time (TypeScript: the check reads at most 1 MiB at a time before any upload, and each file is read whole only after the one before it was sent; Python: the write's traced allocations stay under two 8 MiB files of four), and a `path` rewritten, grown, shrunk or removed after its reservation is refused (`TypeError`, `ValueError`) before any of its bytes are sent, without completing its artifact or writing the case.
- **Python runner files.** `uv run --frozen --all-groups pytest tests/test_evaluations.py -q -k "pinned or evaluator_only"`. Expected: the target sees only agent-visible files (0600 in a 0700 directory), no target, of the case or a later one, finds an evaluator-only file on disk, the local scorer sees every pinned file in `run_experiment` and in `rescore`, and a mismatched download raises `CaseFileError` before any execution starts.
- **TypeScript direct case files.** `bun test tests/files.test.ts -t "evaluator-only files are gone"`. Expected: the scorer grades the evaluator-only template from disk, and when the case ends that copy is gone while the agent's copies, its work and its outputs stay.

## World client names

`WorldClient.createWorld`, `listWorlds` and `getWorld` share the existing identity, pagination,
validation and transport behavior with the compatibility methods. Run
`bun test tests/world-client.test.ts` from `packages/sdk-typescript` for canonical and legacy
routes, identical request bodies, runtime IDs, account tokens and opaque model cursors. The
installed-package verifier runs the same file against the packed exports. World APIs in this
checkout remain subject to the release boundary in `WORLDS.md`.
