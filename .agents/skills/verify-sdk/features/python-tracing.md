# Python tracing

An application opens `Hue(base_url, api_key, ...)`, records spans, model calls and tools, and `force_flush()` returns whether the export was acknowledged.

## Sub-features

- `py-span` records `span`, `model`, `tool` and `context` with input and output.
- `py-capture` honors `capture_content` and redaction before export.
- `py-ack` returns `force_flush()` and receipt results that match the receiver.

## How to get to it (user POV)

- `from hue_sdk import Hue` after `pip install hue-run` (packages/sdk-python/README.md).

## Driving it with uv and the loopback stub (fake Hue API)

Preconditions:

- `uv sync --frozen --all-groups` done in `packages/sdk-python`; stub running; `HUE_BASE_URL` exported.

- **Drive.** From `packages/sdk-python`:

  ```sh
  uv run --frozen --all-groups python -c '
  import os
  from hue_sdk import Hue
  with Hue(os.environ["HUE_BASE_URL"], "synthetic-verify-key", capture_content=True, service_name="verify-sdk") as hue:
      hue.validate_project()
      with hue.span("agent.run") as run:
          run.set_input({"q": "hello"}); run.set_output({"a": "HELLO"}); trace = run.trace_id
      print("trace_id", trace, "flushed", hue.force_flush())
  '
  cat "$V"/stub.log
  ```

  Expected: `trace_id <32 hex> flushed True`, and the stub logs `GET /api/v1/projects/current` and `POST /api/v1/otlp/v1/traces` with status 200.
- **Behavior test.** `uv run --frozen --all-groups pytest tests/test_sdk.py -q -k redact`. Expected: all selected tests pass in about 2 s.
- **Static checks** (3.5 s): `uv run --frozen --all-groups ruff check src tests && uv run --frozen --all-groups mypy`.

## Gotchas

- The Python version is independent of the TypeScript version (see `pyproject.toml`).
- `RUST_LOG=info` in the shell makes uv print resolver noise; ignore it or run `RUST_LOG= uv ...`.
- CI also runs Python 3.10. Mention it if your change touches syntax or typing that 3.10 lacks.

## Recorded media and file uploads

- `py-media` covers the shared `tests/fixtures/media-parts/cases.json` corpus across `gen_ai.input.messages`, `gen_ai.output.messages` and `ai.prompt.messages`, including OpenAI content arrays. Compare both successful uploads and failed uploads with each fixture's exact messages and ordered compact JSON strings in `hue.blobs`. Hash the decoded bytes, not their base64 spelling. Declared `text/plain` non-data content such as `YWJj` stays raw UTF-8. An invalid declared MIME type falls back to a valid data URL MIME type, then the binary/text default.
- Binary parts export part-level `sha256` and `size` at every size. Successful text uploads over 64 KiB retain a UTF-8-safe 16 KiB prefix and a content-field blob entry. Failed text uploads retain the digest and size without an entry.
- Names accept Unicode, must be nonempty, contain at most 256 characters and have no control characters. Invalid source names stay in the message but do not enter blob metadata. Remote URLs, file IDs and S3 locations stay unchanged and cause no fetch.
- `py-file-upload` covers `record_file`: the existing `hue.file` event stays present, `upload` defaults to `False`, and supplied data is limited to 25 MiB. With `upload=True`, a successful upload adds `event:hue.file:<sha256>` to the same span. Digest-only records do not upload.
- Verify duplicate media is reserved once per trace, failed uploads add no entries, and `capture_content=False` and setup credentials cause no upload requests. Whole string attributes retain their separate 1,000,000,000-byte upload limit.
- Media inspection stops at 8 MiB per message attribute and 16 MiB per record. A skipped value keeps its original content for ordinary hold, cut or drop admission. Recognized resource, event, link and log attributes digest before snapshot admission without uploading, reading the upload memo or changing the span's own digest receipts. Scope attributes and log bodies keep ordinary copying.

Run `uv run --frozen --all-groups pytest tests/test_media_parts.py -q` for inspection limits, nested admission, upload-state isolation, capture opt-out and same-pointer loopback upload regressions. The installed wheel verifier runs these tests against the built package too.

Use a loopback receiver that implements blob reservation, byte upload and completion for the success path, then refuse reservation or upload for the fallback path. The generic `stub-hue.py` returns 404 for blobs and proves only fallback. Repeat the helper upload and privacy checks from an installed wheel and inspect the decoded OTLP payload and received bytes.
